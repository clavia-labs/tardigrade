# Experimental core

Atoms compose actor state and proposed work. The runtime commits and executes that work through services supplied by platform layers.

```text
src/
├── atoms/                 authoring primitives
│   ├── atom.ts            reactive values
│   ├── durable.ts         event reducers and state codecs
│   ├── effect.ts          views and proposed events or acts
│   ├── act.ts             external work declarations
│   ├── promise.ts         durable results
│   ├── graph.ts           graph inspection
│   └── store.ts           live atom registry
├── actor/                 definitions, methods, messages, cancellation, threads
├── runtime/
│   ├── effects.ts         references, execution handles, outcomes, errors
│   ├── events.ts          framework lifecycle records
│   ├── execution.ts       commit, execute, settle, cancel, checkpoint
│   ├── replay.ts          event validation and graph recovery
│   ├── event-source.ts    journal projections
│   ├── actors.ts          addressed runtime lifetimes
│   ├── messages.ts        reply obligations
│   ├── layers.ts          service composition
│   ├── contracts.ts       actor runtime interfaces
│   └── stores/            observable journal and thread views
├── services/              journal, execution, promises, isolate,
│                          actor, invocation, supervisor, checkpoint, backup
└── index.ts               public exports
quint/                     safety and liveness models
```
