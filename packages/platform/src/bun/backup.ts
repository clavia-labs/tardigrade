import { createHash, randomUUID } from "node:crypto"
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { RemoteBackup, RemoteBackupError, remoteBackupFromKeyValueStore, type HostCheckpoint } from "@clavia/tardigrade-core"
import { KeyValueStore } from "effect/unstable/persistence"

// bunBackup stores checkpoints in a filesystem directory; callers must choose a destination outside host storage.
export const bunBackup = (options: { readonly directory: string; readonly namespace: string }) =>
  remoteBackupFromKeyValueStore(options.namespace).pipe(
    Layer.provide(KeyValueStore.layerFileSystem(options.directory)),
    Layer.provide(BunServices.layer),
  )

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
const backupError = (message: string, cause: unknown): RemoteBackupError => new RemoteBackupError({ message, cause })

export interface CheckpointPolicy {
  readonly maxBytes: number
}

export const DEFAULT_CHECKPOINT_POLICY: CheckpointPolicy = { maxBytes: 256 * 1024 * 1024 }

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

// captureHostCheckpoint snapshots SQLite databases and rejects detected storage changes during capture.
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
export const restoreHostCheckpoint = (options: {
  readonly actor: string
  readonly storage: string
  readonly backup: Layer.Layer<RemoteBackup, Error>
  readonly id?: string
  readonly policy?: Partial<CheckpointPolicy>
}) => Effect.gen(function* () {
  const { storage, maxBytes } = yield* Effect.try({ try: () => {
    if (options.storage === ":memory:") throw new Error("memory storage cannot be restored")
    const maxBytes = options.policy?.maxBytes ?? DEFAULT_CHECKPOINT_POLICY.maxBytes
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("checkpoint maxBytes must be a positive integer")
    const storage = resolve(options.storage)
    if (existsSync(storage)) throw new Error(`restore destination already exists: ${storage}`)
    return { storage, maxBytes }
  }, catch: cause => backupError("invalid restore destination", cause) })
  const read = Effect.gen(function*() {
    const backup = yield* RemoteBackup
    const id = options.id ?? (yield* backup.latest)
    if (id === undefined) return yield* backupError("no complete backup is available", undefined)
    const checkpoint = yield* backup.load(id)
    if (checkpoint === undefined) return yield* backupError(`backup checkpoint ${id} is missing`, undefined)
    return { checkpoint, id }
  })
  const { checkpoint, id } = yield* Effect.provide(read, options.backup.pipe(Layer.catch((cause) => Layer.effect(RemoteBackup, Effect.fail(backupError("backup layer failed", cause))))))
  return yield* Effect.try({ try: () => {
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
  }, catch: cause => backupError("checkpoint restore failed", cause) })
})
