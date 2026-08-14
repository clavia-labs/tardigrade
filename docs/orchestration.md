# Orchestration

A multi-agent system in this framework is sessions delegating to sessions. The framework ships
three small pieces: one awaitable delegation function with a code face and a model face, a session
host that resolves addresses to programs, and two carried facts from which provenance and cost are
derived. Topology, retries, and gathering stay in user code.

## Why This Shape

Multi-agent patterns churned through 2025 and 2026, and the field's most credible practitioners
each reversed their public position within a year.
[Prior art](prior-art.md#multi-agent-evidence) records the evidence. The patterns that survived
production share four substrate properties:

1. Every stage leaves an auditable artifact.
2. Information crosses an agent boundary as a small declared artifact, and a collaborator that
   adds no new signal makes the system worse.
3. Writes have one owner.
4. Failures are observable across the whole system, with provenance per claim.

The event log and the single writer already guarantee 1 and 3. Delegation adds 2 and 4 as
properties of the crossing itself. The framework ships no supervisor, swarm, or debate primitive,
because those are the parts that keep changing; they compose from the pieces below in a few lines
of user code.

A second premise: model capability keeps compounding, so orchestration authority that a model
handles poorly today it may handle well within months. Every capability here therefore has two
faces over the same events, and moving authority between them is configuration.

## One Function, Two Faces

`callAgent(address, message)` is delegation as a value: it routes one `MessageReceived` through
`Router.call` and returns a `SubagentResult` with the child's output or error and the child's
inclusive usage.

- The code face awaits it. A machine, a workflow, or a code-mode sandbox writes fan-out and
  gathering as ordinary code: run several calls concurrently and the join is the language's own
  `await`, with deadlines and retries as ordinary combinators around it.
- The model face is `subagentTool(options)`, the same call wrapped as a provider-native tool. The
  model sees an ordinary tool whose result carries the child's answer and spend.

Both faces send the same event and read the same reply, so a run driven by generated code and a
run driven by tool calls leave the same evidence in the logs.

## The Boundary Contract

Exactly two facts cross the boundary, one in each direction.

- Outward, the message carries `origin`: the sending session, and, when sent while serving a turn,
  the turn and tool call that asked. The child's inbound head records it.
- Homeward, the result carries the child's inclusive usage: its own model spend plus everything
  its own delegations reported. The parent's `ToolReturned` records it.

Neither side reads the other's log. From these two fields, the delegation tree, ancestry, blast
radius, and tree cost are all derived by projections; nothing else needs to be carried, stored, or
kept consistent. `treeUsageIn(log, turn)` folds one turn's total spend including every agent it
called. [Events](events.md) lists the fields; [Observability](observability.md#cost-projections)
covers the projections.

The asynchronous door follows the same contract. A turn whose head names `replyTo` delivers its
outcome as a new `MessageReceived` at that address, stamped with `origin`, `outcome`, and `usage`.

## Session Host

`host({ programs })` is the in-process map from an address to a running session. It removes the
route glue a multi-session application otherwise writes by hand.

```ts
import { host } from "flamecast-core/harness"

const h = host({
  programs: {
    "agent:supervisor": supervisor,
    "agent:verify": verifier,
    "researcher/*": (address) => researcherFor(address)
  }
})

const terminal = await Effect.runPromise(h.call("agent:supervisor", { id: "m-1", text: "go" }))
```

- A registry maps an exact address, or a `prefix/*` pattern, to a program or a factory. A spawned
  session keeps one program for its lifetime.
- The host creates a session's store and writer lease on first delivery, settles the program's
  machines under that session's services, and answers with the terminal event stamped with tree
  usage.
- `h.route` plugs into any runtime's `route` option, and `h.log` and `h.sessions` expose the
  swarm's evidence for inspection.

The host is also where swarm safety lives, because it sees every crossing. It walks the derived
origin chain and refuses a delegation cycle or a delegation past `maxDepth` with a failed turn
instead of a deadlock or a runaway. A durable runtime replaces this host wholesale: on such a
platform an address names a durable object or a cell, and hosting is the platform's job.
[Runtimes](runtimes.md) owns binding status.

## Model Heterogeneity

The model is a property of the child's program, never of the delegation. Each program's
`inference` module selects its own provider, so a supervisor on one model delegating to workers on
another is just two entries in the registry. A registry factory can pick the model from the
address, and provider selection can be a function of the child's own log.

## Widening Model Authority

How much orchestration the model drives is configuration:

1. Fixed peers: `subagentTool` entries with fixed addresses. The model chooses when to ask, never
   whom.
2. Spawns: a `prefix/*` registry entry lets the model open fresh sessions under a namespace the
   application chose.
3. Generated orchestration: a code-execution module exposes `callAgent` inside the sandbox, and
   the model writes the fan-out, joins, and retries as code.

All three leave the same events, so widening authority as models improve changes configuration and
prompt, never architecture. An orchestration module is source, so
[evolution](evolution.md) can search it like any other candidate.

## What Stays in User Code

The framework ships no planner, role taxonomy, debate protocol, or peer mesh. The evidence shows
role splits losing context at each handoff, debate matching self-consistency at equal budget, and
unstructured meshes amplifying one injected error system-wide. The surviving patterns are short
compositions:

- A verifier is a `subagentTool` whose message is a projected artifact, answered by a fresh
  session with no parent history.
- Research fan-out is several `callAgent` calls joined by the language, or several tool calls if
  the model drives.
- Map, reduce, and manage is a workflow machine calling `callAgent` deterministically.
- A retry is a new call with a new id; the child's dedup absorbs a redelivered one.

## Invariants

1. A message that crosses sessions names its origin.
2. A parent observes a child only through its reply.
3. The host refuses cycles and bounds depth from derived ancestry, so recursion ends in a failed
   turn instead of a deadlock.
4. Usage folds up the delegation tree.
5. A crossing leaves committed events in both logs, so a swarm replays session by session.
