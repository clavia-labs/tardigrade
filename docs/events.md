# Events

## Event Shape

Every stored row is an open `Event` with a required `type` and module-defined fields.

Common fields include:

- `id` for inbound identity
- `turn` for turn attribution
- `callId` for provider or tool intent identity
- `at` for recorded time
- `agent` for the agent that accepted the inbound message
- `origin` for the session, turn, and call that sent a cross-session message
- `usage` on a cross-session reply for the sender's inclusive spend
- `continuation` on a model result for opaque provider state
- `attempt`, `notBefore`, and `reason` on a model deferral for the journaled wait
- `reserved` on a model call for the estimated spend of an in-flight attempt
- `reason` on a model settle for why an attempt closed without a provider result

Unknown fields and event types survive reads and folds.

The open shape is the right contract for reading, and the wrong one for writing the harness's own events: a misspelled field compiles, and `keyOf` reads `callId` to derive a dedup key, so a `ToolReturned` carrying `calId` derives no key and the store stops absorbing its redeliveries. The constructors in `flamecast-core/harness` name each event's fields, and the built-in modules emit through them. They return a plain `Event`, so every reader keeps its tolerant read.

## Append-Only Rules

1. An event records a past fact.
2. Existing events are never edited or deleted.
3. Effects record both intent and outcome when the protocol needs crash recovery.
4. Turn-scoped events carry `turn` explicitly.
5. World-supplied ids are namespaced by their uniqueness scope in the dedup key.

## Dedup Keys

The event store receives a `DedupKey` policy. Harness users pass `keyOf` from `flamecast-core/harness` to their runtime.

Examples:

- an inbound message dedups by message id
- a model result dedups by turn and call id
- a model settle has no key, so every closed reservation stays in the log as evidence
- a tool result dedups by turn and call id
- a budget grant or denial dedups by turn and request call id
- a model deferral has no key, so every wait stays in the log as evidence

This lets providers reuse `call_1` in later turns without the store confusing separate calls. A grant and denial for one budget request share a key, so the first committed decision wins.

## Standard Alphabet

| Module | Event types |
| --- | --- |
| inference | `MessageReceived`, `ModelCalled`, `ModelDeferred`, `AlarmFired`, `ModelSettled`, `ModelReturned`, `TextReturned`, `TurnCompleted`, `TurnFailed`, `ReplyDelivered` |
| native-tools | `ToolCalled`, `ToolReturned` |
| budget | `BudgetExhausted`, `BudgetRequested`, `BudgetGranted`, `BudgetDenied` |
| contract | `AnswerRejected` |
| compaction | `CompactionFired`, `CompactionCompleted` |

Modules declare the event types they own. `agent.definition.events` is the sorted union. `undeclaredEvents(definition, log)` reports rows outside that declared alphabet.

Cross-session delegation adds no event types. A delegation is a `ToolCalled` and `ToolReturned` in the parent log and a `MessageReceived` plus a terminal in the child log, tied together by `origin`. [Orchestration](orchestration.md#the-boundary-contract) covers the fields that cross.

## Custom Events

A custom module lists its event names in `setup().events` and teaches its machines how to project them. No central union changes.

```ts
const approval = defineModule({
  id: "approval",
  setup: () => ({
    events: ["ApprovalRequested", "ApprovalGranted", "ApprovalDenied"],
    machines: [approvalMachine]
  })
})
```

The event log itself is the complete evaluation record. Export formats can be added at boundaries without changing the internal model.
