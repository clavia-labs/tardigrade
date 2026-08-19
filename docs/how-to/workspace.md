How to read a spilled value back: slice one by ref, search across all of them, and query them where a platform bound SQL.

A result too large for a turn's context spills. The event keeps a pointer with the ref, a preview, and the whole size, and the value itself goes to the store under that ref ([boundary.md](../explanations/boundary.md)). The workspace package is how the model gets the rest of that value back. It is mounted by `createRlmAgent`, so a body calls it like any other package.

### Slice one value

`workspace.read({ ref, offset, length })` answers a slice and the whole value's size. `length` clamps to the read cap, so a body that asks for everything gets a bounded answer and the size it would need to page through. An offset past the end answers with an empty slice and the true size, which is the cue to aim at a smaller offset.

```ts
const { slice, size } = await workspace.read({ ref: "t1.result", offset: 0, length: 4000 })
```

### Search across values

`workspace.grep({ pattern, ref })` searches every value the store holds, or one of them when `ref` is given. Each match carries the ref, the offset, and a context window around the hit, so the next `read` starts where the match is. The search sees a value whole however large it grew, which is why a match inside a value far too big for one event is still found.

```ts
const { matches } = await workspace.grep({ pattern: "invoice_id" })
const hit = matches[0]
const { slice } = await workspace.read({ ref: hit.ref, offset: hit.offset, length: 2000 })
```

### Query, where the platform bound it

`workspace.sql({ query, params })` exists only when the platform bound a SQL surface through `WorkspaceSql`. A platform with a SQL-backed store binds it and the verb appears, with its own docs and annotation; a platform on a plain key/value backend binds nothing and the model sees a workspace with two verbs. The model is never offered a tool that cannot work, so nothing has to explain a tool that always errors.

```ts
const layer = Layer.succeed(WorkspaceSql, { sql: (query, params) => runOnThePlatform(query, params) })
```

### The bounds

`WorkspacePolicy` names them: `sliceChars` caps `read`, `contextChars` is the window each match carries, and `maxMatches` is where a match-heavy pattern stops and the answer says it is truncated. `DEFAULT_WORKSPACE_POLICY` states the framework's numbers, and `createRlmAgent` takes an override under `policy.workspace` like every other policy ([policy.md](policy.md)). The method docs the model reads state the numbers in force, so a moved bound moves the words too.

```ts
const agent = createRlmAgent({ infer, policy: { workspace: { sliceChars: 8_000, maxMatches: 20 } } })
```
