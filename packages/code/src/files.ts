import { Effect } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Path } from "effect/Path"
import type { Package } from "./packages"

// The files package: a directory the code may read and write, and nothing outside it. The methods
// are built on `FileSystem` and `Path` rather than on a runtime's own file API, so the package is a
// value any platform binds (`BunFileSystem.layer` and `BunPath.layer` on bun) and a test binds a
// real directory it owns.
//
// The root is the whole of the confinement. Every argument is resolved against it and a path that
// lands outside answers `{ error }`, so a model that asks for `../etc/passwd` reads why it was
// refused and can ask again (files.test.ts, "a path outside the root is refused"). The check is
// lexical: it reads the resolved path, so a symlink already inside the root that points outside is
// followed. A root that holds symlinks out of itself is a root that is wider than it looks.

// FilesPolicy bounds what one call can put in a turn's context and how far a walk goes. `readChars`
// caps `read`, and a larger `length` argument clamps to it; it is also how much of one file
// `search` scans. `maxEntries` caps a listing and the number of files a search walks. `maxMatches`
// is where a match-heavy pattern stops and reports itself truncated. `skip` names directories the
// walk never enters, because a repository's own history and its installed packages are noise the
// model pays context for.
export interface FilesPolicy {
  readonly root: string
  readonly readChars: number
  readonly maxEntries: number
  readonly maxMatches: number
  readonly skip: ReadonlyArray<string>
}

export const DEFAULT_FILES_READ_CHARS = 32_768
export const DEFAULT_FILES_MAX_ENTRIES = 500
export const DEFAULT_FILES_MAX_MATCHES = 50
export const DEFAULT_FILES_SKIP: ReadonlyArray<string> = [".git", "node_modules"]

// defaultFilesRoot is the root an assembly that states none confines to: the working directory of
// the process that built the package. It is a function rather than a constant because a constant
// would freeze the directory at import time, and the consumer that chdirs before assembling would
// silently get the wrong one.
export const defaultFilesRoot = (): string => process.cwd()

export const filesPolicyOf = (policy: Partial<FilesPolicy> = {}): FilesPolicy => ({
  root: policy.root ?? defaultFilesRoot(),
  readChars: policy.readChars ?? DEFAULT_FILES_READ_CHARS,
  maxEntries: policy.maxEntries ?? DEFAULT_FILES_MAX_ENTRIES,
  maxMatches: policy.maxMatches ?? DEFAULT_FILES_MAX_MATCHES,
  skip: policy.skip ?? DEFAULT_FILES_SKIP
})

// Confined is one resolved path, or the sentence the model reads instead. The root itself resolves
// to the empty relative path, so `files.list({})` names the root and is inside it.
type Confined = { readonly path: string } | { readonly error: string }

const confine = (path: Path, root: string, asked: string | undefined): Confined => {
  const resolved = path.resolve(root, asked === undefined || asked === "" ? "." : asked)
  const relative = path.relative(root, resolved)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { error: `path '${asked}' is outside the root this agent may reach` }
  }
  return { path: resolved }
}

// A path the model reads is stated relative to the root, so the answer never carries the machine's
// own directory layout and a model that echoes a path back states one this package accepts.
const shown = (path: Path, root: string, resolved: string): string => {
  const relative = path.relative(root, resolved)
  return relative === "" ? "." : relative
}

const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export interface FilesOptions {
  readonly policy?: Partial<FilesPolicy>
}

// filesPackage builds the package. Its methods need `FileSystem` and `Path`, stated in the type as
// `Package<FileSystem | Path>`: the code funnel runs every method under the attempt's own context,
// so an assembly that mounts this package cannot run on a host that binds neither
// (packages/code/src/execute.ts, codeReactorFor).
export const filesPackage = (options: FilesOptions = {}): Package<FileSystem | Path> => {
  const policy = filesPolicyOf(options.policy)
  const root = policy.root
  return {
    name: "files",
    description:
      "The files under one root directory. files.read and files.list see what is there, files.search finds text across it, and files.write puts a file back. Every path is relative to the root and a path outside it is refused.",
    annotations: {
      read: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      list: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      search: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      // A write replaces a file whole, so it destroys whatever was there; writing the same text
      // twice leaves the same file, so it is idempotent. Neither reaches past the root.
      write: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    docs: {
      read: {
        description: `Read one file as text. offset/length in characters; length caps at ${policy.readChars}. \`size\` is the whole file's length, so an offset past the end answers with an empty slice and the size to aim at.`,
        input: {
          type: "object",
          properties: { path: { type: "string" }, offset: { type: "number" }, length: { type: "number" } },
          required: ["path"]
        },
        output: {
          type: "object",
          properties: {
            text: { type: "string" },
            size: { type: "number" },
            truncated: { type: "boolean" },
            error: { type: "string" }
          }
        }
      },
      list: {
        description: `List one directory. Each entry: name and type ("File" or "Directory"). The root is the default, and at ${policy.maxEntries} entries the answer says truncated.`,
        input: { type: "object", properties: { path: { type: "string" } } },
        output: {
          type: "object",
          properties: {
            entries: { type: "array" },
            truncated: { type: "boolean" },
            error: { type: "string" }
          }
        }
      },
      search: {
        description: `Substring search across the files under one directory, the root by default. Each match: path, line number, and the whole line. ${policy.skip.join(" and ")} are never entered, at most ${policy.maxEntries} files are read, and at ${policy.maxMatches} matches the answer says truncated.`,
        input: {
          type: "object",
          properties: { pattern: { type: "string" }, path: { type: "string" } },
          required: ["pattern"]
        },
        output: {
          type: "object",
          properties: {
            matches: { type: "array" },
            truncated: { type: "boolean" },
            error: { type: "string" }
          }
        }
      },
      write: {
        description:
          "Write text to one file, replacing whatever was there. Directories on the way are created. Answers the path written and how many characters it holds.",
        input: {
          type: "object",
          properties: { path: { type: "string" }, text: { type: "string" } },
          required: ["path", "text"]
        },
        output: {
          type: "object",
          properties: { path: { type: "string" }, size: { type: "number" }, error: { type: "string" } }
        }
      }
    },
    methods: {
      read: (args: unknown) =>
        Effect.gen(function* () {
          const a = args as { path?: string; offset?: number; length?: number } | undefined
          if (!a?.path) return { error: "files.read needs { path }" }
          const path = yield* Path
          const fs = yield* FileSystem
          const confined = confine(path, root, a.path)
          if ("error" in confined) return confined
          const whole = yield* fs.readFileString(confined.path).pipe(
            Effect.map((text) => ({ text })),
            Effect.catch((error) => Effect.succeed({ error: failure(error) }))
          )
          if ("error" in whole) return whole
          const from = Math.max(0, Math.floor(a.offset ?? 0))
          const take = Math.min(Math.max(0, Math.floor(a.length ?? policy.readChars)), policy.readChars)
          const slice = whole.text.slice(from, from + take)
          const truncated = from + slice.length < whole.text.length
          return { text: slice, size: whole.text.length, ...(truncated ? { truncated } : {}) }
        }),
      list: (args: unknown) =>
        Effect.gen(function* () {
          const a = args as { path?: string } | undefined
          const path = yield* Path
          const fs = yield* FileSystem
          const confined = confine(path, root, a?.path)
          if ("error" in confined) return confined
          const names = yield* fs.readDirectory(confined.path).pipe(
            Effect.map((names) => ({ names })),
            Effect.catch((error) => Effect.succeed({ error: failure(error) }))
          )
          if ("error" in names) return names
          const kept = [...names.names].sort().slice(0, policy.maxEntries)
          const entries = yield* Effect.forEach(kept, (name) =>
            fs.stat(path.join(confined.path, name)).pipe(
              Effect.map((info) => ({ name, type: String(info.type) })),
              Effect.orElseSucceed(() => ({ name, type: "Unknown" }))
            ))
          const truncated = names.names.length > kept.length
          return { entries, ...(truncated ? { truncated } : {}) }
        }),
      // The walk is breadth-first over directories the policy does not skip, and it reads at most
      // `maxEntries` files: a search over a tree nobody bounded would otherwise cost a turn's whole
      // context before the first match (files.test.ts, "search finds text under the root").
      search: (args: unknown) =>
        Effect.gen(function* () {
          const a = args as { pattern?: string; path?: string } | undefined
          const pattern = a?.pattern ?? ""
          if (pattern === "") return { error: "files.search needs { pattern }" }
          const path = yield* Path
          const fs = yield* FileSystem
          const confined = confine(path, root, a?.path)
          if ("error" in confined) return confined
          const matches: Array<{ path: string; line: number; text: string }> = []
          const queue: Array<string> = [confined.path]
          let read = 0
          let truncated = false
          while (queue.length > 0 && !truncated) {
            const here = queue.shift()!
            const names = yield* fs.readDirectory(here).pipe(Effect.orElseSucceed(() => [] as Array<string>))
            for (const name of [...names].sort()) {
              if (truncated) break
              if (policy.skip.includes(name)) continue
              const child = path.join(here, name)
              const info = yield* fs.stat(child).pipe(
                Effect.map((info) => String(info.type)),
                Effect.orElseSucceed(() => "Unknown")
              )
              if (info === "Directory") {
                queue.push(child)
                continue
              }
              if (info !== "File") continue
              if (read >= policy.maxEntries) {
                truncated = true
                break
              }
              read++
              const text = yield* fs.readFileString(child).pipe(Effect.orElseSucceed(() => undefined))
              if (text === undefined) continue
              const lines = text.slice(0, policy.readChars).split("\n")
              for (let i = 0; i < lines.length; i++) {
                const line = lines[i]!
                if (!line.includes(pattern)) continue
                if (matches.length >= policy.maxMatches) {
                  truncated = true
                  break
                }
                matches.push({ path: shown(path, root, child), line: i + 1, text: line })
              }
            }
          }
          return { matches, ...(truncated ? { truncated } : {}) }
        }),
      write: (args: unknown) =>
        Effect.gen(function* () {
          const a = args as { path?: string; text?: string } | undefined
          if (!a?.path) return { error: "files.write needs { path }" }
          if (typeof a.text !== "string") return { error: "files.write needs { text } as a string" }
          const path = yield* Path
          const fs = yield* FileSystem
          const confined = confine(path, root, a.path)
          if ("error" in confined) return confined
          const text = a.text
          const written = confined.path
          return yield* Effect.gen(function* () {
            yield* fs.makeDirectory(path.dirname(written), { recursive: true })
            yield* fs.writeFileString(written, text)
            return { path: shown(path, root, written), size: text.length }
          }).pipe(Effect.catch((error) => Effect.succeed({ error: failure(error) })))
        })
    }
  }
}
