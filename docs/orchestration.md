# Orchestration

A multi-agent system is sessions delegating to sessions. The framework ships one awaitable delegation function with a code face and a model face, an adapter that turns an agent into what a runtime can serve, and two carried facts from which provenance and cost are derived. Topology, retries, and gathering stay in user code.

## Why This Shape

Multi-agent patterns turn over faster than the framework under them, so the framework holds what the patterns are built from. [Prior art](prior-art.md#multi-agent-evidence) records the evidence. The arrangements that hold up in production share four substrate properties:

1. Every stage leaves an auditable artifact.
2. Information crosses an agent boundary as a small declared artifact, and a collaborator that adds no new signal makes the system worse.
3. Writes have one owner.
4. Failures are observable across the whole system, with provenance per claim.

The event log and the single writer guarantee 1 and 3. Delegation adds 2 and 4 as properties of the crossing itself. The framework ships no supervisor, swarm, or debate primitive, because those are the parts that turn over, and they compose from the pieces below in a few lines of user code.

A second premise: model capability compounds, so a model may come to handle orchestration that it handles poorly today. Every capability here therefore has two faces over the same events, and moving authority between them is configuration.

## One Function, Two Faces

`callAgent(address, message)` is delegation as a value: it routes one `MessageReceived` through `Router` and returns a `SubagentResult` with the answer or the error, plus the inclusive usage of whatever answered.

- The code face awaits it. A machine, a workflow, or a code-mode sandbox writes fan-out and gathering as ordinary code: run several calls concurrently and the join is the language's own `await`, with deadlines and retries as ordinary combinators around it.
- The model face is `subagentTool(options)`, the same call wrapped as a provider-native tool. The model sees an ordinary tool whose result carries the answer and the spend.

Both faces send the same event and read the same reply, so a run driven by generated code and a run driven by tool calls leave the same evidence in the logs.

## The Boundary Contract

Exactly two facts cross the boundary, one in each direction.

- Outward, the message carries `origin`: the sending session, and, when sent while serving a turn, the turn and tool call that asked. The receiving session's inbound head records it.
- Homeward, the result carries inclusive usage: the answering session's own model spend plus everything its own delegations reported.

Neither side reads the other's log. From these two fields, the delegation tree, ancestry, blast radius, and tree cost are all derived by projections; nothing else needs to be carried, stored, or kept consistent. `treeUsageIn(log, turn)` folds one turn's total spend including every agent it called. [Events](events.md) lists the fields; [Observability](observability.md#cost-projections) covers the projections.

The asynchronous door follows the same contract. A turn whose head names `replyTo` delivers its outcome as a new `MessageReceived` at that address, stamped with `origin`, `outcome`, and `usage`.

## Serving an Agent

`serve(agent)` turns an agent into what a runtime can hold at an address: an event goes in, the terminal event comes out.

```ts
import { serve } from "flamecast-core/harness"
import { InMemoryRuntime } from "flamecast-core/runtime-in-memory"

const runtime = InMemoryRuntime({
  keyOf,
  sessions: {
    "agent:lead": serve(lead),
    "agent:verify": serve(verifier),
    "worker/*": (address) => serve(workerFor(address))
  }
})
```

This is the whole adapter between the two halves of a multi-agent system. An agent is behavior and knows no address. A runtime owns addresses, storage, and leases and knows no agent vocabulary. Because the registry holds plain functions, an application whose sessions are machines rather than agents registers its own function of the same shape and needs nothing from the harness.

`serve` also carries the guards, because they read the harness alphabet that a runtime does not know. It walks the derived `origin` chain through the `Sessions` port and refuses a delegation cycle or a delegation past `maxDepth` with a failed turn, so recursion ends in an answer instead of a deadlock.

## The Registry

The registry is runtime configuration: it says who answers where. An exact key names one address. A `prefix/*` key, or a bare `*`, names a family and holds a factory that receives the address, so the key's shape says which is which. The most specific key wins, and a factory runs once per address, so a session keeps one behavior for its lifetime.

An address that no key claims answers with a failed turn rather than hanging. A session appears the first time an address records something, so an address a caller invents costs nothing until it is used.

## Calling and Reading

There is one paradigm for one agent and for fifty. `Router` sends, `Sessions` reads, and both arrive through Effect requirements like every other port.

```ts
const answer = await Effect.runPromise(
  Effect.provide(callAgent("agent:lead", { id: "m-1", text: "go" }), runtime)
)

const evidence = await Effect.runPromise(
  Effect.provide(
    Effect.gen(function* () {
      const sessions = yield* Sessions
      return { held: yield* sessions.list, log: yield* sessions.read("agent:verify") }
    }),
    runtime
  )
)
```

Reading a session is reading a log, so every projection applies unchanged to another session's evidence. That is the whole inspection surface for a swarm: the delivery tree is derived from the `origin` each inbound head carries.

## Model Heterogeneity

The model is a property of the answering agent, never of the delegation. Each agent's `inference` module selects its own provider, so a lead on one model delegating to workers on another is two entries in the registry. A factory can pick the model from the address, and provider selection can be a function of the session's own log.

## Widening Model Authority

How much orchestration the model drives is configuration:

1. Fixed peers: `subagentTool` entries with fixed addresses. The model chooses when to ask, never whom.
2. Spawns: a `prefix/*` registry entry lets the model open fresh sessions under a namespace the application chose.
3. Generated orchestration: [code mode](codemode.md) offers the `agents` capability inside a sandbox, and the model writes the fan-out, joins, and retries as source.

All three leave the same events, so widening authority as models improve changes configuration and prompt, never architecture. An orchestration module is ordinary source that an application can version, test, replace, or generate.

## What Stays in User Code

The framework ships no planner, role taxonomy, debate protocol, or peer mesh. The evidence shows role splits losing context at each handoff, debate matching self-consistency at equal budget, and unstructured meshes amplifying one injected error system-wide. The surviving patterns are short compositions:

- A verifier is a `subagentTool` whose message is a projected artifact, answered by a fresh session with no history of the work.
- Research fan-out is several `callAgent` calls joined by the language, or one script the model wrote, or several tool calls.
- Map, reduce, and manage is a workflow machine calling `callAgent` deterministically.
- A retry is a new call with a new id; the receiver's dedup absorbs a redelivered one.

## Invariants

1. A message that crosses sessions names its origin.
2. A caller observes another session only through its reply.
3. Cycles and depth are refused from derived ancestry, so recursion ends in a failed turn instead of a deadlock.
4. Usage folds up the delegation tree.
5. A crossing leaves committed events in both logs, so a swarm replays session by session.
