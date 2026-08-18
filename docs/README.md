# tardigrade docs

Organized on the Diátaxis grid: learning, tasks, information, understanding.

- [quickstart.md](quickstart.md): the concepts in one page. Events, projections, transitions, reactors, an agent in three reactors.
- [tutorials/](tutorials/): guided builds.
  - [rlm-agent.md](tutorials/rlm-agent.md): a Recursive Language Model agent with durable code execution. Ends by killing it mid-recursion.
- [how-to/](how-to/): task-shaped recipes.
  - [gate-tools.md](how-to/gate-tools.md): hide, reveal, or revoke tools from the log.
- [reference/](reference/): neutral per-symbol contracts, no analogies.
  - [api.md](reference/api.md): Event, Projection, Transition, Reactor, Actor, send, settle, resting, Usage.
- [explanations/](explanations/): the why and the mental model.
  - [why.md](explanations/why.md): state = memo { f(log) }, the convergence of durable systems, agents as the new users, the last inversion.
  - [reactors.md](explanations/reactors.md): the reactor model, with the React analogy and the math.
  - [actors.md](explanations/actors.md): one log, its reactors, and the settle loop.

Owed, in priority order: a guarantees-and-limits page (exactly-once vs at-least-once, determinism rules, log growth, when tardigrade is the wrong tool), a "thinking in tardigrade" decomposition guide (feature to events to projections to reactors), and how-tos for testing reactors, sub-agents, and event schema evolution.
