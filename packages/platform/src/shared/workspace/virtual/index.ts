import { Effect, Layer, Semaphore } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { FilesystemWorkspace, FilesystemWorkspaceError, workspaceIdempotency, type WorkspaceIdempotencyOptions, readWorkspaceContent, type WorkspaceReadOptions, DEFAULT_FILESYSTEM_WORKSPACE_POLICY, editWorkspaceText, workspaceText, filesystemWorkspacePolicy, type FilesystemWorkspaceService } from "@clavia/tardigrade-libraries/filesystem/index"
import { sqliteWorkspaceStore, type VirtualWorkspaceSnapshot } from "./sqlite"
import { workspaceNetworkPolicy, type WorkspaceNetworkPolicy } from "../network"
import { sqlIdempotencyStore } from "../idempotency-store"
import { DEFAULT_VIRTUAL_BASH_PROFILE, restoreVirtualFilesystem, snapshotVirtualFilesystem, validateVirtualSnapshot, virtualBash, virtualWorkspacePath, type VirtualBashLimits, type VirtualBashProfile, type VirtualWorkspaceExecutor, type VirtualWorkspacePolicy } from "./bash"

export { DEFAULT_VIRTUAL_WORKSPACE_CHUNK_BYTES, type VirtualWorkspaceEntry, type VirtualWorkspaceSnapshot } from "./sqlite"
export { virtualBash, DEFAULT_VIRTUAL_BASH_PROFILE, type VirtualBashInput, type VirtualBashResult, type VirtualBashLimits, type VirtualBashProfile, type VirtualWorkspaceExecutor, type VirtualWorkspacePolicy } from "./bash"
export const DEFAULT_VIRTUAL_WORKSPACE_DIRECTORY = "/workspace"
export const DEFAULT_VIRTUAL_WORKSPACE_POLICY: VirtualWorkspacePolicy = { ...DEFAULT_FILESYSTEM_WORKSPACE_POLICY, maxFileBytes: 8 * 1024 * 1024 }

export interface VirtualWorkspaceOptions extends WorkspaceReadOptions {
  readonly network?: WorkspaceNetworkPolicy
  readonly idempotency?: WorkspaceIdempotencyOptions | true
  readonly name: string
  readonly directory?: string
  readonly policy?: Partial<VirtualWorkspacePolicy>
  readonly executionLimits?: VirtualBashLimits
  readonly executionLimitProfile?: VirtualBashProfile
  readonly executor?: VirtualWorkspaceExecutor
  readonly storageChunkBytes?: number
}

// virtualWorkspace supplies persistent file tools and snapshot-based shell execution.
export function virtualWorkspace(options: VirtualWorkspaceOptions): Layer.Layer<FilesystemWorkspace, FilesystemWorkspaceError, SqlClient.SqlClient> {
  return Layer.effect(FilesystemWorkspace, Effect.gen(function* () {
    const policy = { ...DEFAULT_VIRTUAL_WORKSPACE_POLICY, ...options.policy }
    const directory = yield* Effect.try({ try: () => {
      if (workspaceNetworkPolicy(options.network).mode !== "none") throw new FilesystemWorkspaceError("Virtual workspaces do not provide network access")
      if (!options.name.trim()) throw new FilesystemWorkspaceError("Workspace name must be nonempty")
      filesystemWorkspacePolicy(policy)
      const path = options.directory ?? DEFAULT_VIRTUAL_WORKSPACE_DIRECTORY
      if (!path.startsWith("/") || path.includes("\0") || path.split("/").some(part => part === ".." || part === ".")) throw new FilesystemWorkspaceError("Workspace directory must be an absolute path without . or .. segments")
      return `/${path.split("/").filter(Boolean).join("/")}`
    }, catch: FilesystemWorkspaceError.from })
    const idempotency = options.idempotency === true ? { workspaceId: options.name, store: yield* sqlIdempotencyStore } : options.idempotency
    const store = yield* sqliteWorkspaceStore(options.name, options.storageChunkBytes)
    const lock = yield* Semaphore.make(1)
    const execute = options.executor ?? virtualBash
    const operation = <Value>(run: (snapshot: VirtualWorkspaceSnapshot, signal: AbortSignal) => Promise<{ readonly value: Value; readonly snapshot?: VirtualWorkspaceSnapshot }>) => lock.withPermit(Effect.gen(function* () {
      const snapshot = yield* store.load
      const result = yield* Effect.tryPromise({ try: signal => run(snapshot, signal), catch: FilesystemWorkspaceError.from })
      const next = result.snapshot
      if (next) {
        yield* Effect.try({ try: () => {
          if (next.revision !== snapshot.revision) throw new FilesystemWorkspaceError("Executor returned a different workspace revision")
          validateVirtualSnapshot(next, policy)
        }, catch: FilesystemWorkspaceError.from })
        yield* store.commit(next)
      }
      return result.value
    }).pipe(Effect.mapError(FilesystemWorkspaceError.from)))
    type Files = Awaited<ReturnType<typeof restoreVirtualFilesystem>>
    const file = <Value>(path: string, run: (fs: Files, path: string) => Promise<Value>) => operation(async snapshot => {
      const fs = await restoreVirtualFilesystem(snapshot, policy)
      await fs.mkdir(directory, { recursive: true })
      const value = await run(fs, await virtualWorkspacePath(fs, directory, path))
      return { value, snapshot: await snapshotVirtualFilesystem(fs, snapshot.revision, policy) }
    })
    const write = async (fs: Files, path: string, content: string) => {
      const bytes = new TextEncoder().encode(content).byteLength
      if (bytes > policy.maxFileBytes) throw new FilesystemWorkspaceError(`File byte limit exceeded for ${path}: ${bytes}, limit ${policy.maxFileBytes}`)
      await fs.writeFile(path, content)
    }
    return workspaceIdempotency({
      bash: command => operation(async (snapshot, signal) => {
        const timeout = AbortSignal.timeout(policy.commandTimeoutMs)
        const combined = AbortSignal.any([signal, timeout])
        try {
          const result = await execute({ snapshot, command, directory, policy, executionLimits: options.executionLimits ?? {}, executionLimitProfile: options.executionLimitProfile ?? DEFAULT_VIRTUAL_BASH_PROFILE, signal: combined })
          combined.throwIfAborted()
          return { value: workspaceText(`${result.stdout}${result.stderr}${result.exitCode === 0 ? "" : `\nexit code ${result.exitCode}`}`, policy.maxOutputChars), snapshot: result.snapshot }
        } catch (cause) {
          if (timeout.aborted) throw new FilesystemWorkspaceError(`Command timed out: commandTimeoutMs ${policy.commandTimeoutMs}`, { cause })
          throw cause
        }
      }),
      read: (path, range) => lock.withPermit(Effect.gen(function* () {
        const entries = yield* store.metadata.pipe(Effect.mapError(FilesystemWorkspaceError.from))
        const target = yield* Effect.tryPromise({ try: async () => {
          const fs = await restoreVirtualFilesystem({ revision: 0, entries }, policy)
          await fs.mkdir(directory, { recursive: true })
          const resolved = await fs.realpath(await virtualWorkspacePath(fs, directory, path))
          const entry = entries.find(entry => entry.path === resolved)
          if (!entry || entry.kind !== "file" && entry.kind !== "hardlink") throw new FilesystemWorkspaceError("Read requires a file")
          return entry.kind === "hardlink" ? entry.target! : resolved
        }, catch: FilesystemWorkspaceError.from })
        return yield* readWorkspaceContent(path, store.content(target), policy.maxReadChars, options, range)
      })),
      write: (path, content) => file(path, async (fs, target) => {
        await fs.mkdir(target.slice(0, target.lastIndexOf("/")) || "/", { recursive: true })
        await write(fs, target, content)
      }),
      edit: (path, oldText, newText) => file(path, async (fs, target) => write(fs, target, editWorkspaceText(await fs.readFile(target), oldText, newText))),
    } satisfies FilesystemWorkspaceService, idempotency, ["virtual", options.name, directory, policy, options.executionLimits ?? {}, options.executionLimitProfile ?? DEFAULT_VIRTUAL_BASH_PROFILE], (method, args) => {
      if (method !== "bash") {
        const path = args[0]!
        if (!path || path.includes("\0") || path.split("/").includes("..")) throw new FilesystemWorkspaceError("Path must be nonempty, contained, and contain no NUL")
      }
      if (method === "write" && new TextEncoder().encode(args[1]!).byteLength > policy.maxFileBytes) throw new FilesystemWorkspaceError(`File byte limit exceeded: limit ${policy.maxFileBytes}`)
    })
  }).pipe(Effect.mapError(FilesystemWorkspaceError.from)))
}
