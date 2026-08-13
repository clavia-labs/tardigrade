# Events

## Envelope

Every stored row is an open `Envelope` with a required `type` and module-defined fields.

Common fields include:

- `id` for inbound identity
- `turn` for turn attribution
- `callId` for provider or tool intent identity
- `at` for recorded time
- `program` for the program that accepted the inbound message

Unknown fields and event types survive reads and folds.

## Append-Only Rules

1. An event records a past fact.
2. Existing events are never edited or deleted.
3. Effects record both intent and outcome when the protocol needs crash recovery.
4. Turn-scoped events carry `turn` explicitly.
5. World-supplied ids are namespaced by their uniqueness scope in the dedup key.

## Dedup Keys

The event store receives a `DedupKey` policy. Harness users pass `keyOf` from `@flamecast/harness` to their runtime.

Examples:

- an inbound message dedups by message id
- a model result dedups by turn and call id
- a tool result dedups by turn and call id

This lets providers reuse `call_1` in later turns without the store confusing separate calls.

## Standard Alphabet

| Module | Event types |
| --- | --- |
| inference | `MessageReceived`, `ModelCalled`, `ModelReturned`, `TextReturned`, `TurnCompleted`, `TurnFailed`, `ReplyDelivered` |
| tools | `ToolCalled`, `ToolReturned` |
| budget | `BudgetExhausted`, `BudgetRequested`, `BudgetGranted`, `BudgetDenied` |
| contract | `AnswerRejected` |
| compaction | `CompactionFired`, `CompactionCompleted` |

Modules declare the event types they own. `agent.program.events` is the sorted union. `undeclaredEvents(program, log)` reports rows outside that declared alphabet.

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
