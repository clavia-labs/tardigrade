# Concepts

This page defines the small vocabulary the framework builds on.

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

A projection is a pure function from a log to a value.

```ts
type Projection<Value> = (log: ReadonlyArray<Envelope>) => Value
```

Projections reconstruct current state without adding facts to the log. The active turn, current checkpoint, and rendered model request are projections.

## Machine

A machine is behavior over the event log. Its state is reconstructed by folding events through named transitions.

Each state can define one work slot:

- `decide(log, now, context)` is pure and returns events.
- `act(log, context)` performs an effect and returns events that record the outcome.

`settle` repeatedly folds and runs ready work until the machine rests. `settleAll` reaches a fixpoint across a group of machines.

Use a machine when behavior must append facts, wait for events, or perform effects. A pure projection that changes a request does not need a machine.

## Module

A module is one typed unit of construction.

```ts
interface Module<Id, Services, Requires, R> {
  readonly id: Id
  readonly version?: string
  readonly fingerprint?: unknown
  readonly services?: Context.Context<Services>
  readonly requires?: Requires
  readonly setup: (services: Context.Context<RequiredServices<Requires>>) => ModulePart<R>
}
```

Modules own their configuration and can contribute machines or projections. Module ids are unique. Compilation rejects ambiguous or incomplete compositions.

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

Construction services are already-created, synchronous values. Effectful capabilities and resources use Effect requirements and Layers at execution time. This keeps program construction deterministic and gives resource lifecycles to Effect.

Services connect modules during construction. A module separately contributes observational projections when evolution or inspection should compare a derived value.

## Port

A port is an effectful capability required by a machine, such as event storage, exclusive writing, time, routing, or spill storage. A runtime binds ports for a platform without changing the program.
