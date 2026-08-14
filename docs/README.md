# Documentation

flamecast-core separates deterministic agent structure from platform bindings and model transport.

## Reading Path

```mermaid
flowchart TD
  C[Concepts] --> A[Architecture]
  A --> B[Building an agent]
  B --> M[Modules]
  A --> E[Events]
  A --> R[Runtimes]
  A --> Or[Orchestration]
  A --> O[Observability]
  O --> V[Evolution]
  P[Prior art] --> A
```

1. [Concepts](concepts.md) defines the vocabulary.
2. [Architecture](architecture.md) shows compilation, turn execution, and orchestration.
3. [Building an agent](building-an-agent.md) walks through the public SDK.
4. [Modules](modules.md) documents composition and the built-in module catalog.
5. [Events](events.md) owns the event alphabet and dedup rules.
6. [Runtimes](runtimes.md) owns the platform port contract and binding status.
7. [Orchestration](orchestration.md) covers delegation, the session host, and swarm inspection.
8. [Observability](observability.md) covers reading, rendering, replaying, and forking logs.
9. [Evolution](evolution.md) covers code candidates, finite equivalence, evaluation, and search integration.
10. [Prior art](prior-art.md) records the external systems and research that informed the design.

The repository [README](../README.md) is the package-level entry point.
