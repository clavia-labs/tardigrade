# Prior Art

flamecast-core combines ideas from event-sourced systems, typed effect runtimes, extensible coding agents, and harness optimization research.

## Runtime and State

- [Effect](https://effect.website/) informs typed service ports, layers, structured effects, and testable time.
- Event sourcing informs immutable logs, projections, replay, and committed effect outcomes.
- Actor systems inform per-session identity, routing, and single-writer ownership.

## Extensible Harnesses

- [Pi](https://pi.dev/) demonstrates a small coding-agent core with extension-first behavior, session trees, and explicit context handling. flamecast-core shares the preference for minimal primitives while using typed module dependencies and event-sourced machines.
- [Anthropic's multi-agent research system](https://www.anthropic.com/research/multiagent-systems) demonstrates parallel delegation and coordinator-worker patterns.
- [Recursive language model harnesses](https://alexzhang13.github.io/blog/2026/harness/) motivate leaving orchestration open to generated code and runtime routing.

## Evolution

- [Don't Train the Model, Evolve the Harness](https://huggingface.co/spaces/joelniklaus/harness-optimization) motivates optimizing the code and control structure around a frozen model.
- [Let the Model Write the Code](https://www.cmpnd.ai/blog/let-the-model-write-the-code.html) motivates source-level candidates instead of a closed parameter table.
- [GEPA](https://arxiv.org/abs/2507.19457) motivates reflective search and Pareto selection across tasks.
- [PopuLoRA](https://vmax.ai/roger-creus/populora-co-evolving-llm-populations-for-reasoning-self-play) is an example of a different population-based direction that should fit the same evaluation substrate.

## Compaction

- [Morph](https://www.morphllm.com/) supplies the optional remote compaction path. The framework records checkpoints in the log and retains a deterministic local fallback.
