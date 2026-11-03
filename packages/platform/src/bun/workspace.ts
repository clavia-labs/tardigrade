import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { workspaceNetworkPolicy, type WorkspaceNetworkPolicy } from "../shared/workspace/network"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { Effect, Layer, Semaphore, Stream } from "effect"
import { FilesystemWorkspace, FilesystemWorkspaceError, workspaceIdempotency, type WorkspaceIdempotencyOptions, readWorkspaceContent, type WorkspaceReadOptions, editWorkspaceText, filesystemWorkspacePolicy, workspaceText, type FilesystemWorkspacePolicy } from "@clavia/tardigrade-libraries/filesystem/index"

export interface LocalWorkspaceOptions extends WorkspaceReadOptions {
  readonly network?: WorkspaceNetworkPolicy
  readonly idempotency?: WorkspaceIdempotencyOptions
  readonly directory: string
  readonly policy?: Partial<FilesystemWorkspacePolicy>
}

// localWorkspace uses a local directory; shell commands execute with the host user's permissions.
export function localWorkspace(options: LocalWorkspaceOptions): Layer.Layer<FilesystemWorkspace, FilesystemWorkspaceError> {
  return Layer.effect(FilesystemWorkspace, Effect.gen(function* () {
    const policy = yield* Effect.try({ try: () => {
      if (options.network !== undefined && workspaceNetworkPolicy(options.network).mode !== "all") throw new FilesystemWorkspaceError("Local Bun workspaces cannot enforce network restrictions; use an isolated platform adapter")
      return filesystemWorkspacePolicy(options.policy)
    }, catch: FilesystemWorkspaceError.from })
    const root = yield* Effect.tryPromise({ try: async () => { await mkdir(options.directory, { recursive: true }); return realpath(options.directory) }, catch: FilesystemWorkspaceError.from })
    const lock = yield* Semaphore.make(1)
    const contained = (path: string) => {
      const tail = relative(root, path)
      if (tail === ".." || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw new FilesystemWorkspaceError("Path is outside the workspace directory")
    }
    const pathOf = async (path: string) => {
      if (!path || path.includes("\0")) throw new FilesystemWorkspaceError("Path must be nonempty and contain no NUL")
      const resolved = resolve(root, path)
      contained(resolved)
      let ancestor = resolved
      while (true) {
        try { contained(await realpath(ancestor)); break } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
          const parent = dirname(ancestor)
          if (parent === ancestor) throw error
          ancestor = parent
        }
      }
      return resolved
    }
    const operation = <A>(run: (signal: AbortSignal) => Promise<A>) => lock.withPermit(Effect.tryPromise({ try: run, catch: FilesystemWorkspaceError.from }))
    const write = async (path: string, content: string) => {
      const resolved = await pathOf(path)
      await mkdir(dirname(resolved), { recursive: true })
      await writeFile(resolved, content, "utf8")
    }
    return workspaceIdempotency({
      bash: command => operation(async signal => {
        const timeout = AbortSignal.timeout(policy.commandTimeoutMs)
        const abort = AbortSignal.any([signal, timeout])
        const child = Bun.spawn(["sh", "-c", command], { cwd: root, detached: true, signal: abort, stdout: "pipe", stderr: "pipe" })
        let killFailure: unknown
        const kill = () => {
          try { process.kill(-child.pid, "SIGKILL") } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") killFailure = error
          }
        }
        abort.addEventListener("abort", kill, { once: true })
        try {
          const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
          timeout.throwIfAborted()
          return workspaceText(`${stdout}${stderr}${code === 0 ? "" : `\nexit code ${code}`}`, policy.maxOutputChars)
        } catch (cause) {
          if (timeout.aborted) throw new FilesystemWorkspaceError(`Command timed out after ${policy.commandTimeoutMs}ms`, { cause: killFailure ?? cause })
          throw cause
        } finally { abort.removeEventListener("abort", kill) }
      }),
      read: (path, range) => lock.withPermit(Effect.gen(function* () {
        const target = yield* Effect.tryPromise({ try: () => pathOf(path), catch: FilesystemWorkspaceError.from })
        const source = Stream.fromReadableStream({ evaluate: () => Bun.file(target).stream(), onError: FilesystemWorkspaceError.from })
        return yield* readWorkspaceContent(path, source, policy.maxReadChars, options, range)
      })),
      write: (path, content) => operation(() => write(path, content)),
      edit: (path, oldText, newText) => operation(async () => {
        const resolved = await pathOf(path)
        if (!(await stat(resolved)).isFile()) throw new FilesystemWorkspaceError("Edit requires a file")
        await write(resolved, editWorkspaceText(await readFile(resolved, "utf8"), oldText, newText))
      }),
    }, options.idempotency, ["bun", root, policy], (method, args) => {
      if (method !== "bash") {
        const path = args[0]!
        if (!path || path.includes("\0")) throw new FilesystemWorkspaceError("Path must be nonempty and contain no NUL")
        contained(resolve(root, path))
      }
    })
  }))
}
