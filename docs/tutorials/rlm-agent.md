In this tutorial, you will build a Recursive Language Model agent: an agent that answers questions over a context far larger than any model window by writing code that slices the context and recursively queries itself over the slices (Zhang and Khattab, "Recursive Language Models"). Then you will kill it halfway through a hundred recursive calls and watch it resume without repeating one of them. The techniques are the quickstart's; the recursion is why they matter.

You will learn:
- the code lane's events, the quickstart's protocol one level down
- how keys derived inside a running program make replay safe
- the replay rule: committed calls return from the log, the first missing key runs live
- how a recursive call becomes a child actor, and why the parent rests while it works

### What you are building

An RLM treats a long context as an environment instead of a prompt. The root model never sees the ten million tokens; it sees a description of a variable and a REPL. It writes code; the code peeks and slices the context and calls `llm(prompt, slice)` on pieces; the answers compose into the final output. In tardigrade, every one of those recursive calls lands in the log as a keyed pair, so the whole recursion is durable: a crash at call 61 of 100 costs nothing but call 61.

### The events

You know this protocol from the quickstart, one level down:

```ts
// CodeDispatched: run this body. execId is the execution's identity.
type CodeDispatched = { type: "CodeDispatched"; execId: string; code: string }

// PackageCalled / PackageReturned: one ask from inside the body, and its answer.
type PackageCalled = { type: "PackageCalled"; callId: string; name: string; arguments: unknown }
type PackageReturned = { type: "PackageReturned"; callId: string; result: unknown }

// CodeSettled: the terminal. What the body returned, or why it threw.
type CodeSettled = { type: "CodeSettled"; execId: string; result?: unknown; error?: string }
```

`CodeDispatched` is `MessageReceived`, the call pair is `ToolCalled`/`ToolReturned`, `CodeSettled` is `TurnCompleted`. An execution is a little agent: a dispatch in, keyed asks in the middle, a terminal out. Hold onto that; it becomes literal in the recursion section.

Notice the one new idea, the `callId`: it is `{execId}/{n}`, where `n` is the call's position in execution order. A key derived inside a running program, still deterministic, because the same code making the same calls in the same order derives the same keys. Everything below rests on that.

### The replay rule

One projection (parameterized by the execution), the heart of the page: which calls has this execution already answered?

```ts
// answered: the committed results for one execution, by callId.
const answered = (events: Event[], execId: string): Map<string, unknown> =>
  new Map(
    events
      .filter((e) => e.type === "PackageReturned" && String(e.callId).startsWith(`${execId}/`))
      .map((e) => [e.callId as string, e.result])
  )
```

The executor runs the body in a sandbox where every package call goes through one gate:

```ts
// runCode executes one body. A call with a committed answer returns it from
// the log and never touches the world. The first missing key runs live, and
// its pair is appended before the body continues.
const runCode = async (input: { dispatch: CodeDispatched; prior: Map<string, unknown> }) => {
  let n = 0
  const call = async (name: string, args: unknown) => {
    const callId = `${input.dispatch.execId}/${n++}`
    if (input.prior.has(callId)) return input.prior.get(callId)   // replay: from the log
    const result = await packages[name](args)                     // live: touch the world
    await append([
      { type: "PackageCalled", callId, name, arguments: args },
      { type: "PackageReturned", callId, result },
    ])
    return result
  }
  const outcome = await sandbox(input.dispatch.code, call)
  return [{ type: "CodeSettled", execId: input.dispatch.execId, ...outcome }]
}
```

For the RLM, `packages` holds the environment: `peek(range)` and `grep(pattern)` over the stored context, and `llm(prompt, slice)`, the recursive call.

Notice what replay costs: nothing. No snapshot, no checkpoint file, no resume-point state machine. The log of pairs is the resume point, and re-running the body from the top is safe because every answered call short-circuits into its committed result.

Notice also the rule the sandbox must enforce: the body must be deterministic between runs. No `Date.now()`, no `Math.random()`, no ambient reads outside the gate. Anything nondeterministic goes through a package, where the log pins its answer. The quickstart's purity rule, one level down.

### The code reactor

```ts
// unsettled: the dispatches with no terminal. The quickstart's absence
// pattern, as a projection.
const unsettled: Projection<CodeDispatched[]> = (events) =>
  events
    .filter((e) => e.type === "CodeDispatched")
    .filter((d) => !events.some((e) => e.type === "CodeSettled" && e.execId === d.execId))

// code: one execution per unsettled dispatch.
const code: Reactor = (events) =>
  unsettled(events).map((d) => ({
    key: `settle/${d.execId}`,
    input: { dispatch: d, prior: answered(events, d.execId) },
    act: runCode,
  }))
```

The quickstart's absence pattern: a dispatch with no terminal. The `input` carries the replay cache, derived at render time, so a crashed execution's re-fire arrives already knowing everything the last run finished.

### The root model emits code

```ts
// runLlm: the root model sees the question and a description of the context
// variable, never the context. It answers with code, or with the output.
const runLlm = async (trajectory: Event[]): Promise<(CodeDispatched | TurnCompleted)[]> => {
  const action = await model(trajectory)
  return action.kind === "code"
    ? [{ type: "CodeDispatched", execId: action.execId, code: action.code }]
    : [{ type: "TurnCompleted", output: action.output }]
}

// infer: enabled when every dispatch is settled and no terminal yet.
const infer: Reactor = (events) => {
  if (events.some((e) => e.type === "TurnCompleted")) return []
  const dispatched = events.filter((e) => e.type === "CodeDispatched").length
  const settled = events.filter((e) => e.type === "CodeSettled").length
  if (settled < dispatched) return []
  return [{ key: `llm/${settled}`, input: events, act: runLlm }]
}
```

### The agent

```ts
const rlm: Actor = { reactors: [infer, code, compaction] }

await send(rlm, {
  type: "MessageReceived",
  text: "Which incidents in this quarter's logs share a root cause?",
  contextRef: "logs/q3",   // the ten million tokens stay in storage
})
```

Compaction is the quickstart's, unchanged. A capability built on a different protocol drops into the same list.

### Recursion as child actors

So far `llm(prompt, slice)` runs inline inside the gate: fine for a handful of calls, wrong for a recursion that fans out to fifty sub-questions, because the parent's `runCode` would hold one process hostage for the whole tree. The quickstart's composition rule fixes it: a recursive call is a send to a child RLM actor, and the answer comes back as a landing.

```ts
// llmPackage: dispatch the sub-question to a child RLM and suspend. The
// child's terminal lands back as this call's PackageReturned; the missing
// answer is what keeps this execution enabled until then.
const llmPackage = async (callId: string, args: { prompt: string; slice: Ref }) => {
  await send(child(callId), { type: "MessageReceived", text: args.prompt, contextRef: args.slice,
                              replyTo: { actor: selfId, callId } })
  throw new Suspend()
}
```

The trick is that suspension needs no machinery: the gate appends no `PackageReturned`, the body aborts, and the execution stays enabled (dispatch, no terminal) while the parent rests. When the child's answer lands as this `callId`'s pair, the code reactor re-fires, the body re-runs, every earlier call replays from the log, this one now finds its answer, and execution continues past the point it suspended at. Replay is the suspension mechanism. And each child is a whole RLM, so the recursion nests to any depth, every level durable, every level resting while the ones below it work.

### Kill it

Send the question, let the recursion fan out, and kill the process while ten children are running.

Nothing was saved, because everything already was. Each child's log holds its own progress; the parent's log holds the dispatch, the committed pairs, and the sends already made. On restart, the alarm settles each actor: finished children's answers land, the parent's body re-runs, replays every answered call without touching the world, re-suspends on the ones still owed, and completes when the last landing arrives. No repeated model call, no orphaned child, no resume code anywhere in what you wrote.

That is the point of this tutorial. Durability here is never a feature you add; it is what is left over when the only state is a log and every piece of work, at every level of the recursion, knows its own key.
