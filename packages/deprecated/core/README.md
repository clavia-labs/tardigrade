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
