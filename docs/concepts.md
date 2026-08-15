# Concepts

This page defines the small vocabulary the framework builds on.

## Event

An event is one immutable fact with a required type and module-defined fields.

```ts
interface Event {
  readonly type: string
  readonly [key: string]: unknown
}
```

Events use an open shape so modules can introduce domain vocabulary without changing core. [Events](events.md) defines the standard alphabet and dedup rules.

## Event Log

An event log is the ordered append-only history of one session. It is the source of truth for state, debugging, replay, evaluation, and recovery.

## Projection

A projection is a pure function from a log to a value.

```ts
type Projection<Value> = (log: ReadonlyArray<Event>) => Value
```

Projections reconstruct current state without adding facts to the log. The active turn, current checkpoint, and rendered model request are projections.

## Machine

A machine is behavior over the event log. Its state is reconstructed by folding events through named transitions.

Each state can define one work slot:

- `decide(log, now, context)` is pure and returns events.
- `act(log, context)` performs an effect and returns events that record the outcome.

`settle` repeatedly folds and runs ready work until the machine rests. `settleAll` reaches a fixpoint across a group of machines.

State names are checked in two tiers, because a transition to a state that does not exist is silent otherwise: the fold lands on a name with no definition, later events fall through the tolerant read, and `settle` reads a missing state as resting. For a machine written by hand, the state names are inferred from the keys of the states record, so an undeclared `initial` or `target` fails to compile. For a machine that arrives as generated source, `machine()` repeats both checks over the values and throws at construction, before any log exists.

Use a machine when behavior must append facts, wait for events, or perform effects. A pure projection that changes a request does not need a machine.

## Module

A module is one typed unit of construction.

```ts
interface Module<Id, Services, Requires, R> {
  readonly id: Id
  readonly version?: string
  readonly identity?: unknown
  readonly services?: Context.Context<Services>
  readonly requires?: Requires
  readonly setup: (services: Context.Context<RequiredServices<Requires>>) => ModulePart<R>
}
```

Modules own their configuration and can contribute machines or projections. Module ids are unique. Compilation rejects ambiguous or incomplete compositions.

Compilation checks what a type cannot see, because a module tuple can be generated. A transition on an event no module declares waits forever, a withdrawal that names no offered tool takes nothing away, and a function carried in `identity` hashes to one constant, so two behaviors would share an agent id. Each is rejected where the tuple is known, before any log exists.

`identity` contributes behavior-affecting configuration to the default agent id. [Agent Identity](evolution.md#agent-identity) explains the identity rules.

## Agent

An agent is behavior with no state: the machines, render plan, projections, and identity that `createAgent` compiles from a module tuple. `agent.definition` is that compiled record.

An agent holds no log and no name. Its `turn` effect asks for storage, an address, and the other [ports](#port) through Effect requirements, so one agent value serves any number of conversations at once and none of them can reach another.

Source that a model writes in [code mode](codemode.md) is a script, never an agent. The agent is what offered the tool that ran it.

## Session

A session is one conversation: one address, one event log, one writer lease. It holds all the state an agent does not.

Behavior comes from the agent and identity comes from the session. A [runtime](runtimes.md) marries the two: its registry says which agent answers at which address, and it provides that session's log, name, and services when a delivery arrives. Nothing else needs to know an address exists.

## Service

An Effect service names a typed construction dependency. A module provides service implementations in an Effect `Context`.

```ts
class InferenceStateProjection extends Context.Service<
  InferenceStateProjection,
  Projection<InferenceState>
>()("flamecast/InferenceStateProjection") {}

const services = Context.make(InferenceStateProjection, selectInferenceState)
```

A consumer lists service keys in `requires` and reads implementations with `Context.get`. TypeScript rejects missing dependencies and duplicate providers for literal module tuples. Runtime compilation performs the same validation for generated JavaScript.

Construction services are already-created, synchronous values. Effectful capabilities and resources use Effect requirements and Layers at execution time. This keeps agent construction deterministic and gives resource lifecycles to Effect.

Services connect modules during construction. A module separately contributes observational projections when evolution or inspection should compare a derived value.

## Port

A port is an effectful capability required by a machine, such as event storage, exclusive writing, time, routing, or spill storage. A runtime binds ports for a platform without changing the agent.
