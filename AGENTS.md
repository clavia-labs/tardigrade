# AGENTS.md

[docs/start-here/Welcome.mdx](docs/start-here/Welcome.mdx) introduces the framework and links its published documentation. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the gate, and pull requests.

## Design

No silent hardcoding. When the framework applies a policy value, such as a cap, a threshold, a timeout, or a limit, the consumer must be able to see it and set it. Export the default, accept an override at the call site or on the surface that applies it, and make the effect visible in the output when the policy changes what the model sees. A constant a consumer can read but cannot change is a leaky abstraction; be explicit instead.

## Formal verification tools

On this workstation, TLAPS is installed at `~/.local/opt/tlaps` and TLC at `~/.local/opt/tla2tools/tla2tools.jar`. Use these paths before searching for or downloading tools. `~/.local/opt/tlaps/bin/tlapm --version` identifies the installed proof manager. Java is available at `/opt/homebrew/opt/openjdk/bin/java`.

```sh
~/.local/opt/tlaps/bin/tlapm --strict --nofp --cache-dir /tmp/tardigrade-tlaps-proof packages/core/tla/component/ResponseIdentity.tla
TLA_JAVA=/opt/homebrew/opt/openjdk/bin/java TLA2TOOLS_JAR="$HOME/.local/opt/tla2tools/tla2tools.jar" bun run tla InteractionSubstitution
```

TLAPS needs process inspection to launch its backends; a sandbox error from `/bin/ps` requires running the checker with that access. Keep generated proof caches outside the repository. TLAPS checks deductive proofs; TLC explores configured finite models. Neither alone proves that TypeScript implements the specification.

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
- No rhetorical uniqueness: avoid "the one X", "the canonical X", "never a second concept" as phrasing. When exactly-one is a real invariant, state what enforces it ("duplicate names throw at construction"); when it is not, describe the thing plainly.

## Style

Do not use em dashes, emoji, or "not X, but Y" framing in documentation, code, comments, commits, or pull requests.

Write a paragraph as one line. Editors wrap for the reader, and a hard wrap bakes one width into the source, so a one-word change reads as a reflowed block.

Write documentation greenfield. A page states what is true now. What changed, and what it replaced, belongs in the commit and the pull request. `bun run gate --only=lint:docs` checks the prose rules a code linter cannot see.
