import { posix } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Effect, Layer, Semaphore, Stream } from "effect"
import { Workspace } from "@clavia/tardigrade-libraries/workspace/index"
import { workspaceService } from "./library"
import { WorkspaceBackend, WorkspaceError, workspaceIdempotency, type WorkspaceIdempotencyOptions, readWorkspaceContent, type WorkspaceReadOptions, editWorkspaceText, workspacePolicy, workspaceText, type WorkspacePolicy } from "@clavia/tardigrade-libraries/workspace/index"

export interface WorkspaceProcess {
  readonly stdout: ReadableStream<Uint8Array> | null
  readonly stderr: ReadableStream<Uint8Array> | null
  readonly exitCode: Promise<number>
}
export interface WorkspaceContainer {
  readonly running: boolean
  readonly exec: (command: string[], options?: { readonly cwd?: string; readonly stdout?: "pipe"; readonly stderr?: "pipe"; readonly signal?: AbortSignal }) => Promise<WorkspaceProcess>
  readonly monitor: () => Promise<void>
  readonly destroy: () => Promise<void>
}
export interface WorkspaceFiles {
  readonly readFile: (path: string, options?: { readonly signal?: AbortSignal }) => Promise<Response>
  readonly writeFile: (path: string, content: string, options?: { readonly signal?: AbortSignal }) => Promise<void>
  readonly mkdir: (path: string, options?: { readonly recursive?: boolean; readonly signal?: AbortSignal }) => Promise<void>
}
export interface ContainerWorkspacePolicy extends WorkspacePolicy {
  readonly startupTimeoutMs: number
  readonly startupPollIntervalMs: number
}
export const DEFAULT_CONTAINER_WORKSPACE_POLICY: ContainerWorkspacePolicy = { ...workspacePolicy(), startupTimeoutMs: 120_000, startupPollIntervalMs: 250 }
export const DEFAULT_WORKSPACE_RELEASE = "destroy" as const
export type WorkspaceRelease = "retain" | "unmount" | "destroy"
export interface ContainerWorkspaceOptions extends WorkspaceReadOptions {
  readonly mounts?: readonly WorkspaceMount[]
  readonly idempotency?: WorkspaceIdempotencyOptions
  readonly container: WorkspaceContainer
  readonly files: WorkspaceFiles
  readonly directory: string
  readonly start: () => void | Promise<void>
  readonly policy?: Partial<ContainerWorkspacePolicy>
  readonly release?: WorkspaceRelease
}
export interface WorkspaceMount {
  readonly directory: string
  readonly access: "read-only" | "read-write"
  // connected reports whether the configured mount is present and usable.
  readonly connected: (signal: AbortSignal) => Promise<boolean>
  // mount attaches the configured filesystem or reuses a matching connection.
  readonly mount: (signal: AbortSignal) => Promise<void>
  // flush resolves after preceding workspace mutations are durable in backing storage.
  readonly flush: (signal: AbortSignal) => Promise<void>
  readonly unmount: (signal: AbortSignal) => Promise<void>
}

// workspaceContainerPath resolves paths beneath the configured container directory; shell commands retain container permissions.
function workspaceContainerPath(directory: string, path: string): string {
  if (!posix.isAbsolute(directory) || !path || path.includes("\0")) throw new WorkspaceError("Workspace paths require an absolute directory and a nonempty path without NUL")
  const root = posix.resolve(directory)
  const resolved = posix.resolve(root, path)
  if (root !== "/" && resolved !== root && !resolved.startsWith(`${root}/`)) throw new WorkspaceError("Path is outside the workspace directory")
  return resolved
}

// makeContainerWorkspace supplies scoped workspace operations after startup and optional mount readiness.
export function makeContainerWorkspace(options: ContainerWorkspaceOptions, mount?: WorkspaceMount): Layer.Layer<Workspace | WorkspaceBackend, WorkspaceError> {
  return workspaceService.pipe(Layer.provideMerge(Layer.effect(WorkspaceBackend, Effect.gen(function* () {
    const { policy, mounts } = yield* Effect.try({ try: () => {
      const value = { ...DEFAULT_CONTAINER_WORKSPACE_POLICY, ...options.policy }
      workspacePolicy(value)
      workspaceContainerPath(options.directory, ".")
      const mounts = [...(options.mounts ?? []), ...(mount ? [mount] : [])].sort((left, right) => posix.resolve(left.directory).localeCompare(posix.resolve(right.directory)))
      for (let index = 0; index < mounts.length; index++) {
        const current = mounts[index]!
        if (!posix.isAbsolute(current.directory)) throw new WorkspaceError("Mount directories must be absolute")
        const directory = workspaceContainerPath(options.directory, current.directory)
        if (current.access !== "read-only" && current.access !== "read-write") throw new WorkspaceError("Mount access must be read-only or read-write")
        for (const method of ["connected", "mount", "flush", "unmount"] as const) {
          if (typeof current[method] !== "function") throw new WorkspaceError(`Workspace mount requires ${method}`)
        }
        for (const previous of mounts.slice(0, index)) {
          const parent = posix.resolve(previous.directory)
          if (directory === parent || parent === "/" || directory.startsWith(`${parent}/`)) throw new WorkspaceError(`Workspace mount paths overlap: ${previous.directory} and ${current.directory}`)
        }
      }
      return { policy: value, mounts }
    }, catch: WorkspaceError.from })
    const release = options.release ?? DEFAULT_WORKSPACE_RELEASE
    const lock = yield* Semaphore.make(1)
    let ready = false
    const attached = new Set<WorkspaceMount>()
    let generation = 0
    const ensure = async (signal: AbortSignal) => {
      if (ready && options.container.running) return
      ready = false
      const current = ++generation
      const startup = AbortSignal.any([signal, AbortSignal.timeout(policy.startupTimeoutMs)])
      try {
        if (!options.container.running) { attached.clear(); await options.start() }
        while (true) {
          startup.throwIfAborted()
          try {
            const process = await options.container.exec(["true"], { signal: startup, stdout: "pipe", stderr: "pipe" })
            const [, , code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exitCode])
            if (code !== 0) throw new WorkspaceError("Container readiness command failed")
            break
          } catch (error) {
            if (startup.aborted) throw new WorkspaceError(`Container startup did not complete within ${policy.startupTimeoutMs}ms`, { cause: error })
            await delay(policy.startupPollIntervalMs, undefined, { signal: startup })
          }
        }
        if (!mounts.some(mount => posix.resolve(mount.directory) === posix.resolve(options.directory))) await options.files.mkdir(options.directory, { recursive: true, signal: startup })
        for (const mount of mounts) {
          const connected = await mount.connected(startup)
          attached.add(mount)
          if (!connected) await mount.mount(startup)
        }
        ready = true
        const stopped = () => { if (generation === current) { ready = false; attached.clear() } }
        void options.container.monitor().then(stopped, stopped)
      } catch (cause) {
        if (startup.aborted && !signal.aborted) throw new WorkspaceError(`Container startup did not complete within ${policy.startupTimeoutMs}ms`, { cause })
        throw cause
      }
    }
    const operation = <A>(run: (signal: AbortSignal) => Promise<A>) => lock.withPermit(Effect.tryPromise({ try: async signal => {
      await ensure(signal)
      const value = await run(signal)
      signal.throwIfAborted()
      for (const mount of mounts) if (mount.access === "read-write") {
        try { await mount.flush(signal) } catch (cause) {
          throw new WorkspaceError(`Workspace flush failed for ${mount.directory}; durability is unknown`, { cause })
        }
      }
      return value
    }, catch: WorkspaceError.from }))
    yield* Effect.addFinalizer(() => Effect.tryPromise({ try: async signal => {
      if (release === "retain" || !options.container.running) return
      ready = false
      const failures: unknown[] = []
      for (const mount of mounts.toReversed()) if (attached.has(mount)) {
        try { await mount.unmount(signal); attached.delete(mount) } catch (cause) { failures.push(cause) }
      }
      if (failures.length) throw new AggregateError(failures, "Workspace mount release failed")
      if (release === "destroy") await options.container.destroy()
    }, catch: WorkspaceError.from }).pipe(Effect.orDie))
    const writable = (path: string) => {
      const target = workspaceContainerPath(options.directory, path)
      const mount = mounts.find(mount => {
        const directory = posix.resolve(mount.directory)
        return directory === "/" || target === directory || target.startsWith(`${directory}/`)
      })
      if (mount?.access === "read-only") throw new WorkspaceError(`Workspace mount ${mount.directory} is read-only`)
    }
    const read = async (path: string, signal: AbortSignal) => (await options.files.readFile(workspaceContainerPath(options.directory, path), { signal })).text()
    const write = async (path: string, content: string, signal: AbortSignal) => {
      writable(path)
      const resolved = workspaceContainerPath(options.directory, path)
      await options.files.mkdir(posix.dirname(resolved), { recursive: true, signal })
      await options.files.writeFile(resolved, content, { signal })
    }
    const mountConfiguration = mounts.length === 0 ? "read-write"
      : mounts.length === 1 && posix.resolve(mounts[0]!.directory) === posix.resolve(options.directory) ? mounts[0]!.access
      : mounts.map(mount => [posix.resolve(mount.directory), mount.access])
    return workspaceIdempotency({
      bash: command => operation(async signal => {
        const timeout = AbortSignal.timeout(policy.commandTimeoutMs)
        try {
          const child = await options.container.exec(["sh", "-c", command], { cwd: options.directory, signal: AbortSignal.any([signal, timeout]), stdout: "pipe", stderr: "pipe" })
          const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exitCode])
          timeout.throwIfAborted()
          return workspaceText(`${stdout}${stderr}${code === 0 ? "" : `\nexit code ${code}`}`, policy.maxOutputChars)
        } catch (cause) {
          if (timeout.aborted) throw new WorkspaceError(`Command timed out after ${policy.commandTimeoutMs}ms`, { cause })
          throw cause
        }
      }),
      read: (path, range) => lock.withPermit(Effect.scoped(Effect.gen(function* () {
        const response = yield* Effect.acquireRelease(Effect.tryPromise({ try: async signal => {
          await ensure(signal)
          const response = await options.files.readFile(workspaceContainerPath(options.directory, path), { signal })
          if (!response.ok) { await response.body?.cancel(); throw new WorkspaceError(`File read failed: HTTP ${response.status}`) }
          return response
        }, catch: WorkspaceError.from }), response => Effect.promise(async () => {
          if (response.body && !response.body.locked) await response.body.cancel()
        }))
        const source = response.body ? Stream.fromReadableStream({ evaluate: () => response.body!, onError: WorkspaceError.from }) : Stream.empty
        return yield* readWorkspaceContent(path, source, policy.maxReadChars, options, range)
      }))),
      write: (path, content) => operation(signal => write(path, content, signal)),
      edit: (path, oldText, newText) => operation(async signal => { writable(path); await write(path, editWorkspaceText(await read(path, signal), oldText, newText), signal) }),
    }, options.idempotency, ["container", options.directory, policy, mountConfiguration, ...(mounts.length ? ["flush-before-success"] : [])], (method, args) => {
      if (method !== "bash") writable(args[0]!)
    })
  }))))
}

// containerWorkspace supplies file and shell operations after container and mount readiness.
export const containerWorkspace = (options: ContainerWorkspaceOptions) => makeContainerWorkspace(options)
