import { createHash, randomUUID } from "node:crypto"
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Context, Data, Effect, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"

export interface HostCheckpoint {
  readonly id: string
  readonly actor: string
  readonly createdAt: number
  readonly digest: string
  readonly payload: Uint8Array
}

export class RemoteBackupError extends Data.TaggedError("RemoteBackupError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

// RemoteBackup publishes complete host checkpoints and retrieves the latest published checkpoint.
export class RemoteBackup extends Context.Service<RemoteBackup, {
  readonly save: (checkpoint: HostCheckpoint) => Effect.Effect<void, RemoteBackupError>
  readonly latest: Effect.Effect<string | undefined, RemoteBackupError>
  readonly load: (id: string) => Effect.Effect<HostCheckpoint | undefined, RemoteBackupError>
}>()("tardigrade/RemoteBackup") {}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
const backupError = (message: string, cause: unknown): RemoteBackupError => new RemoteBackupError({ message, cause })

// remoteBackupFromKeyValueStore stores each checkpoint before advertising its ID as complete.
export const remoteBackupFromKeyValueStore = (namespace: string): Layer.Layer<RemoteBackup, never, KeyValueStore.KeyValueStore> => {
  if (!namespace) throw new Error("backup namespace must not be empty")
  return Layer.effect(RemoteBackup, Effect.gen(function*() {
    const store = yield* KeyValueStore.KeyValueStore
    const latestKey = `${namespace}/latest`
    const checkpointKey = (id: string) => `${namespace}/checkpoint/${id}`
    return RemoteBackup.of({
      save: (checkpoint) => Effect.gen(function*() {
        const envelope = JSON.stringify({
          id: checkpoint.id,
          actor: checkpoint.actor,
          createdAt: checkpoint.createdAt,
          digest: checkpoint.digest
        })
        yield* store.set(`${checkpointKey(checkpoint.id)}/payload`, checkpoint.payload)
        yield* store.set(checkpointKey(checkpoint.id), envelope)
        yield* store.set(latestKey, checkpoint.id)
      }).pipe(Effect.mapError((cause) => backupError("checkpoint upload failed", cause))),
      latest: store.get(latestKey).pipe(Effect.mapError((cause) => backupError("checkpoint lookup failed", cause))),
      load: (id) => store.get(checkpointKey(id)).pipe(
        Effect.mapError((cause) => backupError("checkpoint download failed", cause)),
        Effect.flatMap((raw) => Effect.try({
          try: () => {
            if (raw === undefined) return undefined
            const value: unknown = JSON.parse(raw)
            if (typeof value !== "object" || value === null) throw new Error("invalid checkpoint envelope")
            const record = value as Record<string, unknown>
            if (record.id !== id || typeof record.actor !== "string" || typeof record.createdAt !== "number" ||
              typeof record.digest !== "string") throw new Error("invalid checkpoint envelope")
            return { id, actor: record.actor, createdAt: record.createdAt, digest: record.digest }
          },
          catch: (cause) => backupError("checkpoint envelope is invalid", cause)
        })),
        Effect.flatMap((metadata) => metadata === undefined ? Effect.sync(() => metadata) : store.getUint8Array(`${checkpointKey(id)}/payload`).pipe(
          Effect.mapError((cause) => backupError("checkpoint download failed", cause)),
          Effect.flatMap((payload) => payload === undefined
            ? Effect.fail(backupError("checkpoint payload is missing", id))
            : Effect.succeed({ ...metadata, payload }))
        ))
      )
    })
  }))
}

export interface CheckpointPolicy {
  readonly maxBytes: number
  readonly captureTimeoutMs: number
}

export const DEFAULT_CHECKPOINT_POLICY: CheckpointPolicy = { maxBytes: 256 * 1024 * 1024, captureTimeoutMs: 30_000 }

interface CheckpointFile {
  readonly path: string
  readonly digest: string
  readonly data: string
}

interface CheckpointPayload {
  readonly version: 1
  readonly files: ReadonlyArray<CheckpointFile>
}

const filesIn = (directory: string, root: string): ReadonlyArray<string> => {
  if (!existsSync(directory)) return []
  const found: Array<string> = []
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const database = entry.name.replace(/\.sqlite(?:-wal|-shm|-journal)$/, ".sqlite")
    if (database !== entry.name && existsSync(join(directory, database))) continue
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`backup storage contains a symbolic link: ${relative(root, path)}`)
    if (entry.isDirectory()) found.push(...filesIn(path, root))
    else if (entry.isFile()) found.push(path)
    else throw new Error(`backup storage contains an unsupported entry: ${relative(root, path)}`)
  }
  return found
}

const fileStamp = (path: string): string => {
  const stat = statSync(path, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
}

// captureHostCheckpoint rejects overlapping database commits and file changes (backup.test.ts).
export const captureHostCheckpoint = (options: {
  readonly actor: string
  readonly storage: string
  readonly policy?: Partial<CheckpointPolicy>
}, temporaryDirectory?: string): HostCheckpoint => {
  if (options.storage === ":memory:") throw new Error("memory storage cannot be backed up")
  const maxBytes = options.policy?.maxBytes ?? DEFAULT_CHECKPOINT_POLICY.maxBytes
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("checkpoint maxBytes must be a positive integer")
  const root = resolve(options.storage)
  const paths = filesIn(root, root)
  const temporary = temporaryDirectory ?? mkdtempSync(join(tmpdir(), "tardigrade-checkpoint-"))
  const databases = new Map<string, Database>()
  try {
    for (const path of paths) {
      if (path.endsWith(".sqlite")) databases.set(path, new Database(path, { readwrite: true, create: false }))
    }
    const versions = new Map([...databases].map(([path, database]) => [path, database.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version]))
    const stamps = paths.map(fileStamp)
    let bytes = 0
    const files: Array<CheckpointFile> = []
    for (const [index, path] of paths.entries()) {
      const name = relative(root, path)
      const database = databases.get(path)
      let contents: Uint8Array
      if (database !== undefined) {
        const snapshot = join(temporary, `${index}.sqlite`)
        database.query("VACUUM INTO ?").run(snapshot)
        if (statSync(snapshot).size > maxBytes - bytes) throw new Error(`checkpoint exceeds maxBytes ${maxBytes}`)
        contents = readFileSync(snapshot)
      } else {
        if (statSync(path).size > maxBytes - bytes) throw new Error(`checkpoint exceeds maxBytes ${maxBytes}`)
        contents = readFileSync(path)
      }
      bytes += contents.byteLength
      if (bytes > maxBytes) throw new Error(`checkpoint exceeds maxBytes ${maxBytes}`)
      files.push({ path: name, digest: sha256(contents), data: Buffer.from(contents).toString("base64") })
    }
    const after = filesIn(root, root)
    if (after.length !== paths.length || after.some((path, index) => path !== paths[index] || fileStamp(path) !== stamps[index]) ||
      [...databases].some(([path, database]) => database.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version !== versions.get(path))) {
      throw new Error("storage changed during checkpoint capture; retry required")
    }
    const payload = Buffer.from(JSON.stringify({ version: 1, files } satisfies CheckpointPayload))
    if (payload.byteLength > maxBytes) throw new Error(`checkpoint archive exceeds maxBytes ${maxBytes}`)
    return { id: randomUUID(), actor: options.actor, createdAt: Date.now(), digest: sha256(payload), payload: new Uint8Array(payload) }
  } finally {
    try { for (const database of databases.values()) database.close() }
    finally { rmSync(temporary, { recursive: true, force: true }) }
  }
}

const unpack = (checkpoint: HostCheckpoint, id: string, actor: string, maxBytes: number): CheckpointPayload => {
  if (checkpoint.id !== id) throw new Error(`checkpoint ID ${checkpoint.id} does not match ${id}`)
  if (checkpoint.actor !== actor) throw new Error(`checkpoint actor ${checkpoint.actor} does not match ${actor}`)
  if (checkpoint.payload.byteLength > maxBytes) throw new Error(`checkpoint archive exceeds maxBytes ${maxBytes}`)
  if (sha256(checkpoint.payload) !== checkpoint.digest) throw new Error("checkpoint digest mismatch")
  const value: unknown = JSON.parse(Buffer.from(checkpoint.payload).toString("utf8"))
  if (typeof value !== "object" || value === null || !Array.isArray((value as { files?: unknown }).files) ||
    (value as { version?: unknown }).version !== 1) throw new Error("invalid checkpoint archive")
  return value as CheckpointPayload
}

// restoreHostCheckpoint verifies a complete checkpoint before moving it into an absent storage directory.
export const restoreHostCheckpoint = async (options: {
  readonly actor: string
  readonly storage: string
  readonly backup: Layer.Layer<RemoteBackup, Error>
  readonly id?: string
  readonly policy?: Partial<CheckpointPolicy>
}): Promise<string> => {
  if (options.storage === ":memory:") throw new Error("memory storage cannot be restored")
  const maxBytes = options.policy?.maxBytes ?? DEFAULT_CHECKPOINT_POLICY.maxBytes
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("checkpoint maxBytes must be a positive integer")
  const storage = resolve(options.storage)
  if (existsSync(storage)) throw new Error(`restore destination already exists: ${storage}`)
  const read = Effect.gen(function*() {
    const backup = yield* RemoteBackup
    const id = options.id ?? (yield* backup.latest)
    if (id === undefined) throw new Error("no complete backup is available")
    const checkpoint = yield* backup.load(id)
    if (checkpoint === undefined) throw new Error(`backup checkpoint ${id} is missing`)
    return { checkpoint, id }
  })
  const { checkpoint, id } = await Effect.runPromise(Effect.provide(read, options.backup.pipe(Layer.catch((cause) => Layer.effect(RemoteBackup, Effect.fail(backupError("backup layer failed", cause)))))))
  const archive = unpack(checkpoint, id, options.actor, maxBytes)
  mkdirSync(dirname(storage), { recursive: true })
  const staging = mkdtempSync(join(dirname(storage), ".tardigrade-restore-"))
  try {
    const seen = new Set<string>()
    let total = 0
    for (const file of archive.files) {
      if (typeof file.path !== "string" || file.path === "" || isAbsolute(file.path) || file.path.split(/[\\/]/).includes("..") || seen.has(file.path) ||
        typeof file.digest !== "string" || typeof file.data !== "string") throw new Error("invalid checkpoint file")
      seen.add(file.path)
      const target = resolve(staging, file.path)
      if (!target.startsWith(staging + sep)) throw new Error("checkpoint file escapes restore directory")
      const contents = Buffer.from(file.data, "base64")
      total += contents.byteLength
      if (total > maxBytes || sha256(contents) !== file.digest) throw new Error("checkpoint file failed integrity check")
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, contents, { flag: "wx" })
    }
    if (existsSync(storage)) throw new Error(`restore destination already exists: ${storage}`)
    renameSync(staging, storage)
    return checkpoint.id
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
  }
}
