# Contributing

## Prerequisites

[bun](https://bun.sh) 1.3 or newer. It is the runtime, the package manager, and the test runner, so it is the only tool you need to install.

## Setup

```sh
bun install
bun run setup
```

`bun run setup` points git at the tracked hooks directory (`git config core.hooksPath .githooks`). Two hooks run there. `pre-commit` checks the prose rules when a commit touches markdown, which takes milliseconds and catches a wrapped paragraph before you write the commit message. `pre-push` runs the same gate as CI, so a local failure surfaces before the remote round trip. Use narrow gate commands while you iterate. `--no-verify` bypasses either hook for exceptional workflows.

## Before you open a PR

```sh
bun run gate
```

The gate runs lint (oxlint), prose lint (`tools/docs-lint.ts`), typecheck (every package plus root tools), tests (`bun test` per package), and dead-code analysis (knip) in parallel. It must exit 0. Narrow it with `bun run gate --only=typecheck` while iterating. The pre-push hook runs the whole gate.

`any` is a lint error. It defeats the checks the rest of the framework leans on, and every place it looked necessary had an honest type behind it. The one exception is annotated where it sits, with the reason it can not be written any other way.

The prose lint holds markdown to the rules in [AGENTS.md](AGENTS.md) that a code linter cannot see. A paragraph is one line, because hard wrapping bakes one editor's width into the source and makes a one-word change read as a reflowed block. A document states what is true now, so words that narrate the repository's own history belong in the commit and the pull request.

CI runs `bun install --frozen-lockfile` and then the same `bun run gate`. There is no second list of checks to keep in sync, so a green gate locally is a green gate in CI. Commit `bun.lock` with any dependency change.

## PR expectations

- PR titles are validated in CI as Conventional Commits: `type(scope): message`. One commit is one conceptual move. Squash merging uses that title as the default commit title. The [validation workflow](.github/workflows/conventional-commits.yml) defines the accepted types.
- The PR body is read cold. State the change and the reason, then one bullet per conceptual change, then how you verified it.
- Read [AGENTS.md](AGENTS.md) first. It carries the house rules for TypeScript, the architecture invariants, and the writing style, and reviewers hold PRs to them.

## Publishing

Releases are documented in [docs/how-to/publish.md](docs/how-to/publish.md).
