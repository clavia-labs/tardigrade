# Contributing

## Prerequisites

[bun](https://bun.sh) 1.3 or newer. It is the runtime, the package manager, and the test runner,
so it is the only tool you need to install.

## Setup

```sh
bun install
bun run setup
```

`bun run setup` points git at the tracked hooks directory (`git config core.hooksPath .githooks`).
The `pre-push` hook is deliberately empty: CI is the gate of record, and a cheap push gets a PR to
CI sooner.

## Before you open a PR

```sh
bun run gate
```

The gate runs lint (oxlint), typecheck (every package plus root tools), tests (`bun test` per
package), and dead-code analysis (knip) in parallel. It must exit 0. Narrow it with
`bun run gate --only=typecheck` while iterating, and run the whole thing before you push.

CI runs `bun install --frozen-lockfile` and then the same `bun run gate`. There is no second list
of checks to keep in sync, so a green gate locally is a green gate in CI. Commit `bun.lock` with
any dependency change.

## PR expectations

- PR titles are validated in CI as Conventional Commits: `type(scope): message`. One commit is one
  conceptual move. Squash merging uses that title as the default commit title. The
  [validation workflow](.github/workflows/conventional-commits.yml) defines the accepted types.
- The PR body is read cold. State the change and the reason, then one bullet per conceptual
  change, then how you verified it.
- Read [AGENTS.md](AGENTS.md) first. It carries the house rules for TypeScript, the architecture
  invariants, and the writing style, and reviewers hold PRs to them.
