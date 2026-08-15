# Prior Art

flamecast-core combines ideas from event-sourced systems, typed effect runtimes, extensible coding agents, and harness optimization research.

## Runtime and State

- [Effect](https://effect.website/) informs typed service ports, layers, structured effects, and testable time. It also supplies the pieces this repository would otherwise write itself: `Schema` for the declarations that cross a boundary, `Schedule` for retry policy, `Config` and `Redacted` for secrets, and a test clock for code that waits.
- Event sourcing informs immutable logs, projections, replay, and committed effect outcomes.
- Actor systems inform per-session identity, routing, and single-writer ownership.

## Extensible Harnesses

- [Pi](https://pi.dev/) demonstrates a small coding-agent core with extension-first behavior, session trees, and explicit context handling. flamecast-core shares the preference for minimal primitives while using typed module dependencies and event-sourced machines.
- [flamecast's package system](https://github.com/clavia-inc/flamecast) demonstrates SDKs injected by name into a code sandbox, so arbitrary tools reach the model as callable objects. Codemode [capabilities](codemode.md#writing-a-capability) keep that injection and leave out the catalog, install lifecycle, and discovery machinery.
- [Anthropic's multi-agent research system](https://www.anthropic.com/research/multiagent-systems) demonstrates parallel delegation and coordinator-worker patterns.
- [Recursive language model harnesses](https://alexzhang13.github.io/blog/2026/harness/) motivate leaving orchestration open to generated code and runtime routing.

## Evolution

- [Don't Train the Model, Evolve the Harness](https://huggingface.co/spaces/joelniklaus/harness-optimization) motivates optimizing the code and control structure around a frozen model.
- [Let the Model Write the Code](https://www.cmpnd.ai/blog/let-the-model-write-the-code.html) motivates source-level candidates instead of a closed parameter table.
- [GEPA](https://arxiv.org/abs/2507.19457) motivates reflective search and Pareto selection across tasks.
- [PopuLoRA](https://arxiv.org/abs/2605.16727v1) motivates separate teacher and student populations, TrueSkill-guided PFSP matchmaking, and periodic population replacement.

## Multi-Agent Evidence

These sources motivate the delegation design in [Orchestration](orchestration.md).

- [Anthropic's guidance on multi-agent systems](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them) motivates splitting work by context boundary and the clean-context verification subagent.
- [Cognition's production report](https://cognition.com/blog/multi-agents-working) motivates single-threaded writes and manager-to-child delegation. Their earlier [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents) argued the opposite a year before, which motivates shipping primitives instead of patterns.
- [MAST](https://arxiv.org/abs/2503.13657) catalogs fourteen failure modes across seven frameworks and shows most failures are design failures.
- [Reliability limits of delegated planning](https://arxiv.org/abs/2603.26993) proves a delegation chain that adds no new information loses to one centralized decision maker.
- [From Spark to Fire](https://arxiv.org/abs/2603.04474) shows one error injected at a hub reaching every downstream agent, which motivates origin fields and provenance projections.
- [MANTA](https://arxiv.org/abs/2607.28527) motivates trace auditing and treating topology as a searchable artifact.

## Compaction

- [Morph](https://www.morphllm.com/) supplies the optional remote compaction path. The framework records checkpoints in the log and retains a deterministic local fallback.
