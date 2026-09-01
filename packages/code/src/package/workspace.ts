import { Context, Effect } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { DEFAULT_SPILL_POLICY, hydrate, refs } from "../storage/store"
import { definePackage, type Package } from "./definition"

// The workspace package: the model's own view of the store its spilled values live in (store.ts).
// `read` and `grep` are derived from the store alone, so every backend the platform can bind
// answers them, and they see a value whole however large it grew. `sql` is the power tool for
// structure and agent-created tables, and it exists only where a platform bound a SQL surface
// (WorkspaceSql), so the model is never offered a tool that cannot work (workspace.test.ts, W5).

// SqlRunner is the optional SQL surface a platform binds. The answer shape is the model's: `rows`
// when the query returned some, `truncated` when the platform's own row or byte bound cut them, and
// `error` instead of a failure, because a bad query is the model's information to act on.
export interface SqlRunner {
  readonly sql: (
    query: string,
    params: ReadonlyArray<unknown>
  ) => Effect.Effect<{
    readonly rows?: ReadonlyArray<Record<string, unknown>>
    readonly truncated?: boolean
    readonly error?: string
  }>
  // doc is what the platform knows about the surface it bound and the generic text cannot say: the
  // tables that are already there, their columns, the dialect. The sql description is the generic
  // text, then a single space, then this sentence; an absent doc leaves the generic text alone
  // (workspace.test.ts, "the sql verb").
  readonly doc?: string
}

// WorkspaceSql is the binding platforms declare their SQL surface through. Its default is absent,
// so an agent on a plain key/value backend gets a workspace with two verbs and no promise of a
// third.
export const WorkspaceSql: Context.Reference<SqlRunner | undefined> = Context.Reference("code/WorkspaceSql", {
  defaultValue: (): SqlRunner | undefined => undefined
})

// WorkspacePolicy bounds what one call can put in a turn's context. `sliceChars` caps the source
// characters `read` considers, and `inlineChars` caps its complete serialized answer so that answer
// stays below the spill bound. `contextChars` is the window `grep` returns on each side of a match,
// and `maxMatches` is where a match-heavy pattern stops and reports itself truncated.
export interface WorkspacePolicy {
  readonly sliceChars: number
  readonly inlineChars: number
  readonly contextChars: number
  readonly maxMatches: number
}

export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = {
  sliceChars: 32_768,
  inlineChars: DEFAULT_SPILL_POLICY.spillBytes,
  contextChars: 200,
  maxMatches: 50
}

export const workspacePolicyOf = (policy: Partial<WorkspacePolicy> = {}): WorkspacePolicy => ({
  sliceChars: policy.sliceChars ?? DEFAULT_WORKSPACE_POLICY.sliceChars,
  inlineChars: policy.inlineChars ?? DEFAULT_WORKSPACE_POLICY.inlineChars,
  contextChars: policy.contextChars ?? DEFAULT_WORKSPACE_POLICY.contextChars,
  maxMatches: policy.maxMatches ?? DEFAULT_WORKSPACE_POLICY.maxMatches
})

// WORKSPACE_SQL_DESCRIPTION is the part of the sql doc that holds wherever the verb exists. What is
// true of one platform's surface arrives from the runner's own `doc` and is spliced onto the end.
export const WORKSPACE_SQL_DESCRIPTION =
  "Run SQL against the workspace. Spilled values live under their refs; use read/grep for those, and CREATE whatever tables you need for structure. A value above the platform's row bound is not readable through sql; read and grep never miss it."

export interface WorkspaceOptions {
  readonly sql?: SqlRunner
  readonly policy?: Partial<WorkspacePolicy>
}

interface WorkspaceCursor {
  readonly version: 1
  readonly ref: string
  readonly offset: number
  readonly length: number
}

const encodeBase64Url = (value: string): string => {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

const decodeBase64Url = (value: string): string => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
  const binary = atob(padded)
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
}

const workspaceCursor = (cursor: WorkspaceCursor): string => `w1.${encodeBase64Url(JSON.stringify(cursor))}`

const workspaceCursorOf = (value: string): WorkspaceCursor | undefined => {
  try {
    if (!value.startsWith("w1.")) return undefined
    const decoded = JSON.parse(decodeBase64Url(value.slice(3))) as Partial<WorkspaceCursor>
    if (
      decoded.version !== 1 ||
      typeof decoded.ref !== "string" ||
      decoded.ref === "" ||
      !Number.isInteger(decoded.offset) ||
      decoded.offset! < 0 ||
      !Number.isInteger(decoded.length) ||
      decoded.length! < 1
    ) {
      return undefined
    }
    return decoded as WorkspaceCursor
  } catch {
    return undefined
  }
}

// workspacePackage builds the package. The store is a requirement of its methods, stated in the
// type as `Package<KeyValueStore.KeyValueStore>`: the code funnel runs every method under the
// attempt's own context, and the spill store is always in it, so this package mounts on the code
// reactor at any R (packages/code/src/execution/reactor.ts, executeRecorded).
export const workspacePackage = (options: WorkspaceOptions = {}): Package<KeyValueStore.KeyValueStore> => {
  const policy = workspacePolicyOf(options.policy)
  const runner = options.sql
  const sqlDoc = {
    description:
      runner?.doc === undefined || runner.doc === ""
        ? WORKSPACE_SQL_DESCRIPTION
        : `${WORKSPACE_SQL_DESCRIPTION} ${runner.doc}`,
    input: {
      type: "object",
      properties: { query: { type: "string" }, params: { type: "array" } },
      required: ["query"]
    },
    output: {
      type: "object",
      properties: { rows: { type: "array" }, truncated: { type: "boolean" }, error: { type: "string" } }
    }
  }
  return definePackage({
    name: "workspace",
    description:
      runner === undefined
        ? "The agent's workspace: every value a result spilled, whole. workspace.read slices one value by ref, workspace.grep searches across them."
        : "The agent's workspace: every value a result spilled, plus any tables you create. workspace.sql for queries and your own tables; workspace.read / workspace.grep to slice and search spilled values of any size.",
    annotations: {
      ...(runner === undefined
        ? {}
        : { sql: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }),
      read: { readOnlyHint: true, openWorldHint: false },
      grep: { readOnlyHint: true, openWorldHint: false }
    },
    docs: {
      ...(runner === undefined ? {} : { sql: sqlDoc }),
      read: {
        description: `A bounded slice of one spilled value. Start with ref and optional offset/length, then pass nextCursor alone to continue without repeating or skipping a range. Requested length caps at ${policy.sliceChars} characters, and the complete answer caps at ${policy.inlineChars} serialized characters so it stays inline. done says the value is exhausted.`,
        input: {
          type: "object",
          properties: {
            ref: { type: "string" },
            cursor: { type: "string" },
            offset: { type: "number" },
            length: { type: "number" }
          }
        },
        output: {
          type: "object",
          properties: {
            ref: { type: "string" },
            offset: { type: "number" },
            length: { type: "number" },
            size: { type: "number" },
            done: { type: "boolean" },
            nextCursor: { type: "string" },
            slice: { type: "string" },
            error: { type: "string" }
          }
        }
      },
      grep: {
        description: `Substring search across every spilled value (or one ref), any size. Each match: ref, offset, and ${policy.contextChars} characters of context on each side. Use read with the offset to see more. At ${policy.maxMatches} matches the answer says truncated.`,
        input: {
          type: "object",
          properties: { pattern: { type: "string" }, ref: { type: "string" } },
          required: ["pattern"]
        },
        output: {
          type: "object",
          properties: { matches: { type: "array" }, truncated: { type: "boolean" }, error: { type: "string" } }
        }
      }
    },
    methods: {
      ...(runner === undefined
        ? {}
        : {
            sql: (args: unknown) =>
              Effect.gen(function* () {
                const a = args as { query?: string; params?: ReadonlyArray<unknown> } | undefined
                if (!a?.query) return { error: "workspace.sql needs { query }" }
                return yield* runner.sql(a.query, a.params ?? [])
              })
          }),
      // The slice never exceeds the policy's cap however large a `length` the model asks for: the
      // turn's context is what the cap protects (workspace.test.ts, W3).
      read: (args: unknown) =>
        Effect.gen(function* () {
          const a = args as { ref?: string; cursor?: string; offset?: number; length?: number } | undefined
          let request: { readonly ref: string; readonly offset: number; readonly length: number }
          if (a?.cursor !== undefined) {
            if (a.ref !== undefined || a.offset !== undefined || a.length !== undefined) {
              return { error: "workspace.read accepts cursor alone or ref with optional offset/length" }
            }
            const cursor = workspaceCursorOf(a.cursor)
            if (cursor === undefined) return { error: "invalid workspace.read cursor" }
            request = cursor
          } else {
            if (!a?.ref) return { error: "workspace.read needs { ref } or { cursor }" }
            request = { ref: a.ref, offset: a.offset ?? 0, length: a.length ?? policy.sliceChars }
          }
          const whole = yield* hydrate(request.ref).pipe(Effect.orElseSucceed(() => undefined))
          if (whole === undefined) return { error: `no value under ref '${request.ref}'` }
          const from = Math.max(0, Math.floor(request.offset))
          const take = Math.min(Math.max(0, Math.floor(request.length)), policy.sliceChars)
          const answer = (length: number) => {
            const slice = whole.slice(from, from + length)
            const nextOffset = from + slice.length
            const done = take === 0 || nextOffset >= whole.length
            return {
              ref: request.ref,
              offset: from,
              length: slice.length,
              size: whole.length,
              done,
              ...(!done
                ? { nextCursor: workspaceCursor({ version: 1, ref: request.ref, offset: nextOffset, length: take }) }
                : {}),
              slice
            }
          }
          let low = 0
          let high = Math.min(take, Math.max(0, whole.length - from))
          while (low < high) {
            const middle = Math.ceil((low + high) / 2)
            if (JSON.stringify(answer(middle)).length <= policy.inlineChars) low = middle
            else high = middle - 1
          }
          const result = answer(low)
          if (low === 0 && from < whole.length && take > 0) {
            return { error: `workspace.read inline cap ${policy.inlineChars} is too small for its response metadata` }
          }
          return result
        }),
      // Every value the manifest names is searched whole, so a match inside a value far too large
      // for one event is still found and located (workspace.test.ts, W4).
      grep: (args: unknown) =>
        Effect.gen(function* () {
          const a = args as { pattern?: string; ref?: string } | undefined
          const pattern = a?.pattern ?? ""
          if (pattern === "") return { error: "workspace.grep needs { pattern }" }
          const one = a?.ref === undefined || a.ref === "" ? undefined : a.ref
          const held = one === undefined ? yield* refs().pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>)) : [one]
          const matches: Array<{ ref: string; offset: number; context: string }> = []
          let truncated = false
          for (const ref of held) {
            const whole = yield* hydrate(ref).pipe(Effect.orElseSucceed(() => undefined))
            if (whole === undefined) continue
            let at = whole.indexOf(pattern)
            while (at !== -1) {
              if (matches.length >= policy.maxMatches) {
                truncated = true
                break
              }
              const from = Math.max(0, at - policy.contextChars)
              matches.push({ ref, offset: at, context: whole.slice(from, at + pattern.length + policy.contextChars) })
              // The next search starts past this match's context window, so overlapping hits report
              // once and a repeated pattern cannot fill the answer with the same text.
              at = whole.indexOf(pattern, at + pattern.length + policy.contextChars)
            }
            if (truncated) break
          }
          return { matches, ...(truncated ? { truncated } : {}) }
        })
    }
  })
}

// workspaceFor builds the package from the thread's own bindings: the SQL surface, if the platform
// declared one. A thread with no SQL binding gets the two-verb workspace. Which verbs exist is a
// construction-time reading of the bindings, so the build is an effect; what the verbs need at
// call time stays in the package's own type, and the funnel supplies it.
export const workspaceFor = (
  policy: Partial<WorkspacePolicy> = {}
): Effect.Effect<Package<KeyValueStore.KeyValueStore>> =>
  Effect.gen(function* () {
    const sql = yield* WorkspaceSql
    return workspacePackage({ ...(sql === undefined ? {} : { sql }), policy })
  })
