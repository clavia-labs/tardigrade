# AGENTS.md

[docs/README.md](docs/README.md) describes what this repository is and how the framework works.
[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the gate, and pull requests.

This file holds the rules that do not change when the code changes. Keep it short.

## Say each thing once

`docs/` is evergreen. It describes the repository as it is now. When behavior changes, update the
doc in the same change, so a reader can trust the doc over the code.

State a fact in one place. A fact that lives in `docs/` does not get repeated in this file, in a
README, or in a comment. Link to it instead. Two copies of a fact become two different facts.

Keep the docs conceptual. Diagrams, invariants, and links carry more than a file map does. Write
what a thing is and why it has its shape. Leave out sentences that describe the document itself.

## TypeScript

- Avoid dynamic imports. A dynamic import is usually code smell. Use static imports.
- Use inferred return types by default. This keeps the code less verbose.
- Avoid re-exports. Import directly from the canonical location. The one exception is a package's
  `index.ts`, which is the published surface of that package.

## Comments

Comments explain intent. Say why the code took this shape. Delete a comment that restates the line
below it.

## Style

No em dashes, no emoji, and no "not X, but Y" framing in code, comments, commits, or pull requests.

## Before you finish

`bun run gate` passes.
