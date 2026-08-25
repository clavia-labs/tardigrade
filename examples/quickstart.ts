// The agent from docs/quickstart.md, complete and runnable: bun run examples/quickstart.ts
// The types and reactors are the ones the page builds. The pieces the page assumes, a
// runtime, a toolbox, a model, a summarizer, are filled in with the smallest thing that
// runs: the model is scripted and the tools are canned, so the run needs no API key. Swap
// `model` for a real inference call and `toolbox` for real tools to make it an agent.

// An Event is an open record.
type Event = { type: string } & Record<string, unknown>

// Concrete events narrow the shape. These four are the agent's vocabulary.
type MessageReceived = { type: "MessageReceived"; text: string }
type ToolCalled = { type: "ToolCalled"; callId: string; name: string; arguments: unknown }
type ToolReturned = { type: "ToolReturned"; callId: string; result: unknown }
type TurnCompleted = { type: "TurnCompleted"; output: string }

// A Projection derives a value from the event set. It is pure and ignores
// event order; it is recomputed on every read, never stored, never appended.
type Projection<T> = (events: Event[]) => T

// Intent proposes events without external work.
type Intent<T, E extends Event = Event> = {
  kind: "intent"
  key: string
  input: T
  events: (input: T, at: number) => E[]
}

// ExternalEffect performs outside-world work and returns events that record its outcome.
type ExternalEffect<T, E extends Event = Event> = {
  kind: "effect"
  key: string
  input: T
  act: (input: T) => Promise<E[]>
}

// Transition is an intent or external effect offered from one log snapshot.
type Transition<T, E extends Event = Event> = Intent<T, E> | ExternalEffect<T, E>

// Reactor derives the transitions the log enables. The runtime fires each
// key the log does not record and appends the results, keyed record last.
type Reactor = (events: Event[]) => Transition<never>[]

// Actor is the single writer of one log and the reactors over it.
type Actor = { reactors: Reactor[] }

// effect pins T at the construction site, then forgets it: the runtime only ever calls
// act(input) with the input the same derivation produced, so the erasure is sound.
const effect = <T>(work: Omit<ExternalEffect<T>, "kind">): ExternalEffect<never> =>
  ({ kind: "effect", ...work }) as unknown as ExternalEffect<never>

// The runtime. One log, one settle loop. The library records fired keys in the log itself,
// so a crash loses nothing; this in-memory stand-in records them in a set, which is enough
// to show the loop and the absorption.
const log: Event[] = []
const recorded = new Set<string>()

// settle derives and fires transitions until none remain.
const settle = async (actor: Actor): Promise<void> => {
  for (;;) {
    const fires = actor.reactors.flatMap((r) => r(log)).filter((t) => !recorded.has(t.key))
    if (fires.length === 0) return
    for (const t of fires) {
      const events = t.kind === "intent" ? t.events(t.input, Date.now()) : await t.act(t.input)
      recorded.add(t.key)
      log.push(...events)
      for (const e of events) console.log(`  ${t.key} -> ${render(e)}`)
      break
    }
  }
}

// send appends one event and settles the actor.
const send = async (actor: Actor, event: Event): Promise<void> => {
  log.push(event)
  console.log(`  send -> ${render(event)}`)
  await settle(actor)
}

// done: the turn has reached its terminal.
const done: Projection<boolean> = (events) => events.some((e) => e.type === "TurnCompleted")

// The toolbox. Canned answers stand where real tools go.
const toolbox: Record<string, (args: unknown) => Promise<unknown>> = {
  recentDeploys: async () => ["api@2025-08-18", "web@2025-08-17"],
  deployDiff: async (args) => `${JSON.stringify(args)}: rate limiter added to /v1/search`
}

// unansweredCalls: the tool calls with no matching result.
const unansweredCalls: Projection<ToolCalled[]> = (events) =>
  events
    .filter((e): e is ToolCalled => e.type === "ToolCalled")
    .filter((c) => !events.some((e) => e.type === "ToolReturned" && e.callId === c.callId))

// runTool executes one call.
const runTool = async (call: ToolCalled): Promise<ToolReturned[]> => {
  const tool = toolbox[call.name]
  const result = tool === undefined ? { error: `no tool named ${call.name}` } : await tool(call.arguments)
  return [{ type: "ToolReturned", callId: call.callId, result }]
}

// tools: one transition per unanswered call.
const tools: Reactor = (events) =>
  unansweredCalls(events).map((call) => effect({ key: call.callId, input: call, act: runTool }))

// The model. A script stands where inference goes: look at deploys, read the diff, answer.
type Action =
  | { kind: "call"; callId: string; name: string; arguments: unknown }
  | { kind: "done"; output: string }

const model = async (trajectory: Event[]): Promise<Action> => {
  const returned = trajectory.filter((e): e is ToolReturned => e.type === "ToolReturned")
  if (returned.length === 0) return { kind: "call", callId: "call-1", name: "recentDeploys", arguments: {} }
  if (returned.length === 1)
    return { kind: "call", callId: "call-2", name: "deployDiff", arguments: { deploy: "api@2025-08-18" } }
  return { kind: "done", output: "The api deploy added a rate limiter to /v1/search." }
}

// runLlm does one inference. The action lands as an event.
const runLlm = async (trajectory: Event[]): Promise<(ToolCalled | TurnCompleted)[]> => {
  const action = await model(trajectory)
  return action.kind === "call"
    ? [{ type: "ToolCalled", callId: action.callId, name: action.name, arguments: action.arguments }]
    : [{ type: "TurnCompleted", output: action.output }]
}

// infer: an inference is enabled when every call is answered and no terminal yet.
const infer: Reactor = (events) => {
  if (done(events)) return []
  if (unansweredCalls(events).length > 0) return []
  const attempt = events.filter((e) => e.type === "ToolReturned").length
  return [effect({ key: `llm/${attempt}`, input: events, act: runLlm })]
}

// The budget. Small on purpose, so compaction fires inside this short run.
const BUDGET = 250
const sizeOf = (events: Event[]): number => JSON.stringify(events).length

// summarize folds a stretch of events into prose. A model call goes here; a fold of the
// event types is enough to watch the checkpoint land.
const summarize = async (prev: string, events: Event[]): Promise<string> =>
  [prev, ...events.map((e) => e.type)].filter((s) => s.length > 0).join(", ")

// CompactionCompleted is the checkpoint: the summary so far, and the index it covers.
// A render reads the summary plus the events after upTo; nothing is deleted.
type CompactionCompleted = { type: "CompactionCompleted"; summary: string; upTo: number }

// lastCheckpoint: the latest checkpoint, or the empty one.
const lastCheckpoint: Projection<{ summary: string; upTo: number }> = (events) =>
  events.findLast((e): e is CompactionCompleted => e.type === "CompactionCompleted") ?? { summary: "", upTo: 0 }

// A Span is the stretch owed a summary: from the checkpoint it starts at,
// up to the index the next checkpoint will cover.
type Span = { summary: string; events: Event[]; from: number; upTo: number }

// spanOf: the span owed a summary, or null while the log is under budget.
const spanOf: Projection<Span | null> = (events) => {
  const checkpoint = lastCheckpoint(events)
  const since = events.slice(checkpoint.upTo)
  if (sizeOf(since) <= BUDGET) return null
  return { summary: checkpoint.summary, events: since, from: checkpoint.upTo, upTo: events.length }
}

// compact folds a span into the next checkpoint.
const compact = async (span: Span): Promise<CompactionCompleted[]> => {
  const summary = await summarize(span.summary, span.events)
  return [{ type: "CompactionCompleted", summary, upTo: span.upTo }]
}

// compaction: enabled when the events since the checkpoint outgrow the budget.
const compaction: Reactor = (events) => {
  const span = spanOf(events)
  if (!span) return []
  return [effect({ key: `compact/${span.from}`, input: span, act: compact })]
}

// render names an event in one line for the run's printout.
const render = (e: Event): string => {
  if (e.type === "ToolCalled") return `ToolCalled ${String(e["name"])}`
  if (e.type === "ToolReturned") return `ToolReturned ${JSON.stringify(e["result"])}`
  if (e.type === "TurnCompleted") return `TurnCompleted "${String(e["output"])}"`
  if (e.type === "CompactionCompleted") return `CompactionCompleted upTo=${String(e["upTo"])}`
  return `${e.type} ${JSON.stringify({ ...e, type: undefined })}`
}

// The agent. Three reactors on one log; adding a component adds a derivation.
const agent: Actor = { reactors: [infer, tools, compaction] }

console.log("settling:")
await send(agent, { type: "MessageReceived", text: "What changed in the deploy?" } satisfies MessageReceived)
console.log(`resting: ${log.length} events, checkpoint "${lastCheckpoint(log).summary}"`)

export {}
