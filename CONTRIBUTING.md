# Contributing

## Prerequisites

Install Bun 1.4 or later. Bun is the runtime, package manager, and test runner, so it is the only tool you need to install.

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

The gate runs lint (oxlint), prose lint (`tools/docs-lint.ts`), Effect lint (`@effect/tsgo`, one run per TypeScript project), typecheck (every package plus root tools), tests (`bun test` per package), and dead-code analysis (knip) in parallel. It must exit 0. Narrow it with `bun run gate --only=typecheck` while iterating. The pre-push hook runs the whole gate.

The Effect lint reads rules the type checker does not carry: an effect nobody yielded, a requirement nobody provides, a wall clock read inside a replayed body, a schema that admits `NaN`. [tsconfig.effect.json](tsconfig.effect.json) names every installed rule with the severity this repository holds it to, and each rule that is off says why. The gate checks that list against the installed rule catalog, then fails on an error or warning. `bun run lint:effect` runs it alone. A source exception uses `// @effect-diagnostics-next-line <rule>:off` with its reason at the expression it covers.

`any` is a lint error. It defeats the checks the rest of the framework leans on, and every place it looked necessary had an honest type behind it. The one exception is annotated where it sits, with the reason it can not be written any other way.

The prose lint holds markdown to the rules in [AGENTS.md](AGENTS.md) that a code linter cannot see. A paragraph is one line, because hard wrapping bakes one editor's width into the source and makes a one-word change read as a reflowed block. A document states what is true now, so words that narrate the repository's own history belong in the commit and the pull request.

CI runs `bun install --frozen-lockfile` and then the same `bun run gate`. There is no second list of checks to keep in sync, so a green gate locally is a green gate in CI. Commit `bun.lock` with any dependency change.

## PR expectations

- `main` is the default branch and the integration trunk. Feature and fix PRs target `main`.
- PR titles are validated in CI as Conventional Commits: `type(scope): message`. One commit is one conceptual move. Squash merging uses that title as the default commit title. The [validation workflow](.github/workflows/conventional-commits.yml) defines the accepted types. `feat`, `fix`, and `perf` titles bump the next release; `docs`, `chore`, `ci`, and `test` do not.
- The PR body is read cold. State the change and the reason, then one bullet per conceptual change, then how you verified it.
- Read [AGENTS.md](AGENTS.md) first. It carries the house rules for TypeScript, the architecture invariants, and the writing style, and reviewers hold PRs to them.

## Releases

Release Please keeps a release PR current with the version and changelog for the next stable release. Each revision is combined with a pinned `main` commit, tested, and published as `<version>-rc.<run number>` under the npm `next` tag. Merging the release PR creates the stable tag and publishes `<version>` under the npm `latest` tag. A normal merge to `main` only updates the release PR.
