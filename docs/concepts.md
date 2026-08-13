# Concepts

## Event

An event is one immutable fact represented by an `Envelope`.

```ts
interface Envelope {
  readonly type: string
  readonly [key: string]: unknown
}
```

Events use an open shape so modules can introduce domain vocabulary without changing core. [Events](events.md) defines the standard alphabet and dedup rules.

## Event Log

An event log is the ordered append-only history of one session. It is the source of truth for state, debugging, replay, evaluation, and recovery.

## Projection

A projection is a pure function from a log to a value. Examples include the active turn, budget spent, current checkpoint, rendered request, and a module signal.

## Machine

A machine is behavior over the event log. Its state is reconstructed by folding events through named transitions.

Each state can define one work slot:

- `decide(log, now, context)` is pure and returns events.
- `act(log, context)` performs an effect and returns events that record the outcome.

`settle` repeatedly folds and runs ready work until the machine rests. `settleAll` reaches a fixpoint across a group of machines.

## Module

A module is one typed unit of agent construction.

```ts
interface Module<Id, Provides, Requires, R> {
  readonly id: Id
  readonly version?: string
  readonly fingerprint?: unknown
  readonly provides?: Provides
  readonly requires?: Requires
  readonly setup: (context: ModuleContext<Requires>) => ModulePart<R>
}
```

`setup` can contribute event names, machines, static instructions, conditional nudges, tools, and render limits. Configuration stays with the module that owns the behavior.

Module ids are unique. Signal providers are unique. Machine ids, tool names, and instruction ids are also unique after compilation.

## Signal

A signal is typed state announced by one module and read by another.

```ts
const inferenceState = signal<"inference.state", InferenceState>("inference.state")
```

A provider uses `announce(signal, read)`. A consumer lists the signal in `requires` and reads it through its typed `ModuleContext`.

Tuple construction catches missing signals and duplicate module ids in TypeScript. Runtime validation catches the same errors when generated JavaScript bypasses TypeScript.

## Instruction

An instruction is static prompt text owned by a module. Instructions are joined into the stable system prefix in module order.

## Nudge

A nudge is conditional render policy. It has a log predicate, text, and optional tool-surface changes.

A nudge is separate from a machine. A machine changes the log and can perform effects. A nudge reads the log and changes only the next model request.

Nudges default to `placement: "tail"`, which appends them as late system messages and preserves the stable system prefix for provider caching. `placement: "system"` is an explicit opt-in for behavior that must join the prefix.

## Agent Program

`createAgent` compiles modules into an `AgentProgram`.

```ts
interface AgentProgram<R> {
  readonly id: string
  readonly parent?: string
  readonly modules: ReadonlyArray<ModuleManifest>
  readonly events: ReadonlyArray<string>
  readonly machines: ReadonlyArray<Machine<R, never>>
  readonly render: RenderPlan
  readonly announcements: ReadonlyArray<Announcement<AnySignal>>
}
```

The default id hashes ordered module manifests. Functions do not have a stable source-independent representation, so code-generating systems should pass an explicit id derived from source control, build provenance, or their own candidate identity.

## Rendering

`agent.request(log)` is a pure function. It reconstructs the conversation, applies the latest compaction checkpoint, appends active tail nudges, and projects the current tool surface.

Pure rendering enables request comparison before any model call. [Evolution](evolution.md) uses that property to reuse the longest valid prefix of a recorded run.

## Inference Provider

An `InferenceProvider` announces provider, model, and context window state, then reacts to a rendered request. Provider selection may itself be a pure function of the log.

## Replay, Branch, and Fork

Replay appends recorded events and settles the program. Completed effects are read from their committed events, so replay avoids repeating them.

`agent.branch(recorded, { at })` creates an independent in-memory session from a supplied prefix. `agent.fork({ at })` reads the current session and creates the same kind of branch.

## Runtime

A runtime binds the core ports for one platform. The program stays unchanged when the storage, lock, timer, routing, or deployment environment changes. [Runtimes](runtimes.md) owns the port contract.
