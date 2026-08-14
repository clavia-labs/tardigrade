# AGENTS.md

[docs/README.md](docs/README.md) describes what this repository is and how the framework works.
[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the gate, and pull requests.

## Documentation

`docs/` is the source of truth for repository behavior. It describes the repository as it is now.
When behavior changes, update the docs in the same change.

State each fact in one place. If `docs/` contains a fact, link to it from this file, a README, or a
comment.

Keep the docs conceptual. Use diagrams, invariants, and links to explain concepts. Write what a
thing is and why it has its shape. Do not include file maps or descriptions of documents.

## TypeScript

- Use static imports.
- Use inferred return types by default. This keeps the code less verbose.
- Import symbols from their canonical files. Use re-exports only in a package's published
  `index.ts`.

## Comments

Comments explain intent. Say why the code took this shape. Delete a comment that restates the line
below it.

## Style

Use the `simple-english` skill when you write or revise documentation.
Do not use em dashes, emoji, or "not X, but Y" framing in documentation, code, comments, commits,
or pull requests.
