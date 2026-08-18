# AGENTS.md

[docs/README.md](docs/README.md) describes what this repository is and how the framework works. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the gate, and pull requests.

## Documentation

`docs/` is the source of truth for repository behavior. It describes the repository as it is now. When behavior changes, update the docs in the same change.

State each fact in one place. If `docs/` contains a fact, link to it from this file, a README, or a comment.

Keep the docs conceptual. Use diagrams, invariants, and links to explain concepts. Write what a thing is and why it has its shape. Do not include file maps or descriptions of documents.

## Design

No silent hardcoding. When the framework applies a policy value, such as a cap, a threshold, a timeout, or a limit, the consumer must be able to see it and set it. Export the default, accept an override at the call site or on the surface that applies it, and make the effect visible in the output when the policy changes what the model sees. A constant a consumer can read but cannot change is a leaky abstraction; be explicit instead.

## Pull requests

- Title a pull request in the commit format, the same as any commit: `type(scope?): message`, 3 to 5 words. The title becomes the squash commit subject, so it lands in the log as written.
- The pull request body follows the rules in the global writing style. It is read cold, so it states the change and the reason in full.

## Commits

- Use Conventional Commits: `type(scope?): message`.
- Keep the message to 3-5 words.
- Write no body and no trailers.

## Comments

- Go stdlib register: start with the identifier's name; one declarative sentence is the contract; further sentences only for constraints.
- State what the code cannot: the contract, the constraint, the why. Never narrate mechanics or edit history.
- Cite the spec or test that proves any property claimed (e.g. "tla/Reconcile.tla, NoVoid"). A citation can dangle visibly; a freehand assertion rots invisibly.

## Style

Use the `simple-english` skill when you write or revise documentation. Do not use em dashes, emoji, or "not X, but Y" framing in documentation, code, comments, commits, or pull requests.

Write a paragraph as one line. Editors wrap for the reader, and a hard wrap bakes one width into the source, so a one-word change reads as a reflowed block.

Write documentation greenfield. A page states what is true now. What changed, and what it replaced, belongs in the commit and the pull request. `bun run gate --only=lint:docs` checks the prose rules a code linter cannot see.
