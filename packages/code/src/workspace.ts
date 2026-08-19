import { Context, Effect } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import type { Package } from "./packages"
import { hydrate, refs } from "./store"

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

// WorkspacePolicy bounds what one call can put in a turn's context. `sliceChars` caps `read`, and a
// larger `length` argument clamps to it. `contextChars` is the window `grep` returns on each side of
// a match, and `maxMatches` is where a match-heavy pattern stops and reports itself truncated.
export interface WorkspacePolicy {
  readonly sliceChars: number
  readonly contextChars: number
  readonly maxMatches: number
}

export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = { sliceChars: 32_768, contextChars: 200, maxMatches: 50 }

export const workspacePolicyOf = (policy: Partial<WorkspacePolicy> = {}): WorkspacePolicy => ({
  sliceChars: policy.sliceChars ?? DEFAULT_WORKSPACE_POLICY.sliceChars,
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

// workspacePackage builds the package over one store. The store is a value here rather than a
// requirement of the methods, because a package method's environment is fixed by the Package type;
// the lane that holds the store binding builds the package from it (workspaceFor).
export const workspacePackage = (store: KeyValueStore.KeyValueStore, options: WorkspaceOptions = {}): Package => {
  const policy = workspacePolicyOf(options.policy)
  const runner = options.sql
  const of = <A>(effect: Effect.Effect<A, KeyValueStore.KeyValueStoreError, KeyValueStore.KeyValueStore>) =>
    effect.pipe(Effect.provideService(KeyValueStore.KeyValueStore, store))
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
  return {
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
        description: `A bounded slice of one spilled value by ref, any size. offset/length in characters; length caps at ${policy.sliceChars}. \`size\` is the whole value's length, so an offset past the end answers with an empty slice and the size to aim at.`,
        input: {
          type: "object",
          properties: { ref: { type: "string" }, offset: { type: "number" }, length: { type: "number" } },
          required: ["ref"]
        },
        output: {
          type: "object",
          properties: { slice: { type: "string" }, size: { type: "number" }, error: { type: "string" } }
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
          const a = args as { ref?: string; offset?: number; length?: number } | undefined
          if (!a?.ref) return { error: "workspace.read needs { ref }" }
          const whole = yield* of(hydrate(a.ref)).pipe(Effect.orElseSucceed(() => undefined))
          if (whole === undefined) return { error: `no value under ref '${a.ref}'` }
          const from = Math.max(0, Math.floor(a.offset ?? 0))
          const take = Math.min(Math.max(0, Math.floor(a.length ?? policy.sliceChars)), policy.sliceChars)
          return { slice: whole.slice(from, from + take), size: whole.length }
        }),
      // Every value the manifest names is searched whole, so a match inside a value far too large
      // for one event is still found and located (workspace.test.ts, W4).
      grep: (args: unknown) =>
        Effect.gen(function* () {
          const a = args as { pattern?: string; ref?: string } | undefined
          const pattern = a?.pattern ?? ""
          if (pattern === "") return { error: "workspace.grep needs { pattern }" }
          const one = a?.ref === undefined || a.ref === "" ? undefined : a.ref
          const held = one === undefined ? yield* of(refs()).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>)) : [one]
          const matches: Array<{ ref: string; offset: number; context: string }> = []
          let truncated = false
          for (const ref of held) {
            const whole = yield* of(hydrate(ref)).pipe(Effect.orElseSucceed(() => undefined))
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
  }
}

// workspaceFor builds the package from the lane's own bindings: the store it spills to, and the SQL
// surface if the platform declared one. A lane with no SQL binding gets the two-verb workspace.
export const workspaceFor = (
  policy: Partial<WorkspacePolicy> = {}
): Effect.Effect<Package, never, KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore
    const sql = yield* WorkspaceSql
    return workspacePackage(store, { ...(sql === undefined ? {} : { sql }), policy })
  })
