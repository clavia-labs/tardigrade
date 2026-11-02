import { posix } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Effect, Layer, Semaphore } from "effect"
import { FilesystemWorkspace, FilesystemWorkspaceError, editWorkspaceText, filesystemWorkspacePolicy, workspaceText, type FilesystemWorkspacePolicy } from "@clavia/tardigrade-libraries/filesystem/index"

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
export interface ContainerWorkspacePolicy extends FilesystemWorkspacePolicy {
  readonly startupTimeoutMs: number
  readonly startupPollIntervalMs: number
}
export const DEFAULT_CONTAINER_WORKSPACE_POLICY: ContainerWorkspacePolicy = { ...filesystemWorkspacePolicy(), startupTimeoutMs: 120_000, startupPollIntervalMs: 250 }
export const DEFAULT_WORKSPACE_RELEASE = "destroy" as const
export type WorkspaceRelease = "retain" | "unmount" | "destroy"
export interface ContainerWorkspaceOptions {
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
  readonly mount: (signal: AbortSignal) => Promise<void>
  readonly unmount: (signal: AbortSignal) => Promise<void>
}

// workspaceContainerPath resolves paths beneath the configured container directory; shell commands retain container permissions.
function workspaceContainerPath(directory: string, path: string): string {
  if (!posix.isAbsolute(directory) || !path || path.includes("\0")) throw new FilesystemWorkspaceError("Workspace paths require an absolute directory and a nonempty path without NUL")
  const root = posix.resolve(directory)
  const resolved = posix.resolve(root, path)
  if (root !== "/" && resolved !== root && !resolved.startsWith(`${root}/`)) throw new FilesystemWorkspaceError("Path is outside the workspace directory")
  return resolved
}

// makeContainerWorkspace supplies scoped workspace operations after startup and optional mount readiness.
export function makeContainerWorkspace(options: ContainerWorkspaceOptions, mount?: WorkspaceMount): Layer.Layer<FilesystemWorkspace, FilesystemWorkspaceError> {
  return Layer.effect(FilesystemWorkspace, Effect.gen(function* () {
    const policy = yield* Effect.try({ try: () => {
      const value = { ...DEFAULT_CONTAINER_WORKSPACE_POLICY, ...options.policy }
      filesystemWorkspacePolicy(value)
      workspaceContainerPath(options.directory, ".")
      if (mount && posix.resolve(mount.directory) !== posix.resolve(options.directory)) throw new FilesystemWorkspaceError("Mount and workspace directories must match")
      return value
    }, catch: FilesystemWorkspaceError.from })
    const release = options.release ?? DEFAULT_WORKSPACE_RELEASE
    const lock = yield* Semaphore.make(1)
    let ready = false
    let mounted = false
    const ensure = async (signal: AbortSignal) => {
      if (ready && options.container.running) return
      ready = false
      const startup = AbortSignal.any([signal, AbortSignal.timeout(policy.startupTimeoutMs)])
      try {
        if (!options.container.running) await options.start()
        while (true) {
          startup.throwIfAborted()
          try {
            const process = await options.container.exec(["true"], { signal: startup, stdout: "pipe", stderr: "pipe" })
            const [, , code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exitCode])
            if (code !== 0) throw new FilesystemWorkspaceError("Container readiness command failed")
            break
          } catch (error) {
            if (startup.aborted) throw new FilesystemWorkspaceError(`Container startup did not complete within ${policy.startupTimeoutMs}ms`, { cause: error })
            await delay(policy.startupPollIntervalMs, undefined, { signal: startup })
          }
        }
        if (mount) { await mount.mount(startup); mounted = true }
        else await options.files.mkdir(options.directory, { recursive: true, signal: startup })
        ready = true
        void options.container.monitor().then(() => { ready = false; mounted = false }, () => { ready = false; mounted = false })
      } catch (cause) {
        if (startup.aborted && !signal.aborted) throw new FilesystemWorkspaceError(`Container startup did not complete within ${policy.startupTimeoutMs}ms`, { cause })
        throw cause
      }
    }
    const operation = <A>(run: (signal: AbortSignal) => Promise<A>) => lock.withPermit(Effect.tryPromise({ try: async signal => { await ensure(signal); return run(signal) }, catch: FilesystemWorkspaceError.from }))
    yield* Effect.addFinalizer(() => Effect.tryPromise({ try: async signal => {
      if (release === "retain" || !options.container.running) return
      if (mount && mounted) await mount.unmount(signal)
      if (release === "destroy") await options.container.destroy()
      ready = false
    }, catch: FilesystemWorkspaceError.from }).pipe(Effect.orDie))
    const writable = () => { if (mount?.access === "read-only") throw new FilesystemWorkspaceError("Workspace mount is read-only") }
    const read = async (path: string, signal: AbortSignal) => (await options.files.readFile(workspaceContainerPath(options.directory, path), { signal })).text()
    const write = async (path: string, content: string, signal: AbortSignal) => {
      writable()
      const resolved = workspaceContainerPath(options.directory, path)
      await options.files.mkdir(posix.dirname(resolved), { recursive: true, signal })
      await options.files.writeFile(resolved, content, { signal })
    }
    return {
      bash: command => operation(async signal => {
        const timeout = AbortSignal.timeout(policy.commandTimeoutMs)
        try {
          const child = await options.container.exec(["sh", "-c", command], { cwd: options.directory, signal: AbortSignal.any([signal, timeout]), stdout: "pipe", stderr: "pipe" })
          const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exitCode])
          timeout.throwIfAborted()
          return workspaceText(`${stdout}${stderr}${code === 0 ? "" : `\nexit code ${code}`}`, policy.maxOutputChars)
        } catch (cause) {
          if (timeout.aborted) throw new FilesystemWorkspaceError(`Command timed out after ${policy.commandTimeoutMs}ms`, { cause })
          throw cause
        }
      }),
      read: path => operation(async signal => workspaceText(await read(path, signal), policy.maxReadChars)),
      write: (path, content) => operation(signal => write(path, content, signal)),
      edit: (path, oldText, newText) => operation(async signal => { writable(); await write(path, editWorkspaceText(await read(path, signal), oldText, newText), signal) }),
    }
  }))
}

// containerWorkspace supplies file and shell operations on an ephemeral container filesystem.
export const containerWorkspace = (options: ContainerWorkspaceOptions) => makeContainerWorkspace(options)
