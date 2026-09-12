```text
core/src/
├── event.ts
├── machine.ts
├── projection/
├── component/
├── transition/
├── log/
│
├── actor/
│   ├── definition.ts       # Name, methods, components
│   ├── coordinate.ts       # Actor instance and thread coordinates
│   ├── reference.ts        # Typed reference to a thread
│   ├── allocation.ts       # Host allocation contract
│   └── method.ts           # Typed method declarations
│
├── interaction/
│   ├── invocation.ts       # Invocation identity and context
│   ├── events.ts           # Request, response, cancellation records
│   ├── state.ts            # Derive invocation lifecycle from events
│   ├── invoke.ts           # Plan and dispatch a call
│   ├── respond.ts          # Complete a call and return its result
│   ├── cancellation.ts
│   ├── timeout.ts
│   └── relations.ts        # Parent/child and invocation relationships
│
├── transport/
│   ├── envelope.ts         # Addressed payload
│   ├── directory.ts        # Logical coordinate → destination
│   ├── router.ts           # Select delivery route
│   └── transport.ts        # Host-implemented delivery contract
│
└── runtime/
    ├── actor.ts            # Compile definition into executable machinery
    └── reconciler.ts       # Execute transitions and persist results
```

## Durable operations

Use `actorOperations` when an actor call must start before other durable work and finish later.

```ts
const research = actorOperations(worker, "research")
const handle = yield* research.start({ input: { topic: "energy" }, options: { key: "energy" } })
yield* writeCheckpoint({ key: "after-research-start" })
const answer = yield* research.await(handle)
```

If the result is pending, `await` parks the current action. A wake re-executes the action from its start and reconstructs the same handle from the actor call key, so `writeCheckpoint` and other intervening effects must use durable keys. For non-actor work, `durableOperations(adapter)` provides the same start, serializable handle, await, and optional cancel shape. The adapter owns durable keyed acceptance, reference validation, exact terminal reads, and wake delivery.
