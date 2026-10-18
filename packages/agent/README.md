# Agent

Typed actor methods turn inputs into domain events. Durable atoms reduce those events into state, reactive atoms propose work, and service layers execute it.

```text
src/
├── index.ts                   public authoring exports
├── agent.ts                   default graph assembly
├── actor/
│   ├── methods.ts             receive, result, cancellation
│   └── context.ts             construction capabilities
├── contracts/
│   ├── events.ts              domain events and message formats
│   ├── acts.ts                I/O declarations and request helpers
│   ├── budget.ts              budget request and reply schemas
│   └── code-mode.ts           code and package events and acts
├── atoms/
│   ├── index.ts
│   ├── durable/               state schemas, reducers, atoms
│   │   ├── index.ts
│   │   ├── trajectory.ts
│   │   ├── inference.ts
│   │   ├── spend.ts
│   │   ├── permissions.ts
│   │   ├── budget.ts
│   │   ├── tools.ts
│   │   ├── compaction.ts
│   │   └── code-mode.ts
│   ├── infer.ts
│   ├── compact.ts
│   ├── tools.ts
│   ├── code-mode.ts
│   ├── permission-request.ts
│   ├── budget-request.ts
│   ├── tool-promises.ts
│   ├── system.ts
│   ├── messages.ts
│   └── activity.ts
└── services/
    ├── index.ts
    ├── model.ts               provider calls, metadata, act layers
    ├── decisions.ts           permission and budget execution
    ├── tools.ts               package-backed tool execution
    ├── code-mode.ts           isolate and package execution
    └── runtime.ts             service composition and child execution
```

The package root exports actor authoring, contracts, and atoms. Executable layers are available through the `services` subpath.
