# State and compatibility

## Logs, checkpoints, and initial state

```text
ordinary replay:      defaults -------------------> fold events
checkpoint restore:  checkpoint state at position -> fold later events
initialised thread:  caller-supplied atom state ---> fold new events
```

Checkpoint restoration and `StateInitialised` feed the same atom seed mechanism. A checkpoint accelerates restoration within a history. State initialisation starts a new history from supplied state. Keep the initialisation event in durable history so the thread can be rebuilt without a checkpoint.

The event log records inputs, accepted work, and outcomes. Atom state is a projection of those records. Replaying records should reproduce state without reissuing completed work. Pending work can resume through execution services. A durable journal alone does not prove exactly-once external side effects: handlers need an appropriate external idempotency or reconciliation strategy for their transport and storage.

## Migrate at a settled boundary

```text
source log + old actor logic
             |
       replay settled prefix
             |
       application converter
             |
   { destinationAtomName: encodedState }
             |
       destination thread creation
             |
       ThreadCreated
       StateInitialised
       new events ...
```

Choose a boundary with no pending effects, execution handles, or replies. Pause source writes or otherwise pin that settled prefix. Replay using the source logic, convert its result into destination atom codecs, create the destination, then switch routing after successful creation. Source export, conversion, and cutover belong to the application; Tardigrade does not infer how an arbitrary old log maps to a new graph.

`InitialState` is JSON keyed by destination durable atom names. The supplied value is the codec's encoded shape, which may differ from the in-memory TypeScript state. `atom[AtomState]` exposes its name, decoder, and checkpoint encoder.

```ts
import { AtomState, type InitialState } from "tardie/core"

// counter is the destination durable atom; its codec accepts { count: number }.
const initialState: InitialState = {
  [counter[AtomState].name]: { count: replayedOldCount },
}
```

Register destination atoms through the host's `initialStateAtoms: [counter]`, then pass `initialState` to root or child allocation. Unknown names, duplicate destination names, and incompatible values fail before allocation is recorded. Omitted atoms use their defaults. Identical named retries reuse the thread; conflicting supplied state fails.

For a remote destination exposing `methodHttp`, configure those atoms on its host and create through:

```http
POST /v1/actors/destination/threads
Content-Type: application/json

{
  "name": "migrated",
  "initialState": { "example.counter": { "count": 5 } }
}
```

HTTP 400 indicates invalid supplied state. A Cloudflare source still requires the application's source storage access or export path; the destination route does not read the source Durable Object.

For custom journal wiring, call `initialiseState({ journal, atoms, initialState, source? })` before opening the runtime. The journal must be empty or contain only `ThreadCreated`; optional `source` is JSON provenance. Host thread creation commits `ThreadCreated` and `StateInitialised` together before opening the runtime or registering the thread.

Migration transfers supplied atom state. Effects, execution handles, and pending replies are excluded. The destination graph may propose work from that state, so review what its first evaluation enables. Checkpointing takes over normally; capture waits until all supplied atoms have been read.

See [State initialisation](../../../docs/migration/state-initialisation.mdx) for the complete counter conversion and host code. Preserve durable names and codecs for compatible actor updates; use explicit conversion when their state meaning changes.
