# Use the command line

`tdg` is the front door to a running server. It is a few lines over the derived client (`packages/client`), so a command it can send is a route the server declared, and the values it prints are the client's own. The command tree is a declaration: each command states its flags, its arguments, and its description as values, so the help a person reads, the errors a mistake gets, and the completions a shell installs all come from the same tree the parser runs.

## Run it

```bash
bun add @clavia/tardigrade
bunx tdg --help
```

Inside this repository the same command runs from the workspace:

```bash
bun run --cwd apps/cli start -- --help
```

## The commands

| Command | What it does |
| --- | --- |
| `tdg dev` | Boot the API and serve the built UI at one URL. One process, one port, one thing to stop. |
| `tdg run "<brief>"` | Start a thread, wait for its turn to settle, and print what it answered. |
| `tdg send <thread> "<brief>"` | Deliver a brief and print the turn handle without waiting. |
| `tdg ls` | Every thread a store holds, parent before child, as a table. |
| `tdg events <thread>` | The log, one line per event. |

`tdg --help` prints the tree and `tdg <command> --help` prints one command. A command nobody declared exits non-zero and says which command it looked like.

Every command names a thread, never an actor. A v1 server serves one actor and reserves the name `agent` for it, so the client fills that level in and a command states only the thread it reads or writes ([the server's vocabulary](server.md)).

## Configuration resolves in one place

A flag beats the environment, and the environment is the server's own surface, read by the server's own reader (`apps/server/src/config.ts`, `readConfig`), so a variable the server honours is a variable this command honours. There is no config file and no third source.

| What | Flag | Environment | Default |
| --- | --- | --- | --- |
| The server to call | `--url` | absent | `DEFAULT_BASE_URL` (`packages/client/src/client.ts`) |
| The bearer token the remote commands present | `--token` | `TARDIGRADE_TOKEN` | absent |
| The port `tdg dev` listens on | `--port` | `PORT` | `DEFAULT_PORT` (`apps/server/src/config.ts`) |
| The store `tdg dev` opens | `--db` | `TARDIGRADE_DB` | `DEFAULT_DB` (`apps/server/src/config.ts`) |
| The model binding | absent | `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_ID`, `MODEL_PROVIDER` | absent |

The model is yours. This framework ships no provider, no endpoint, and no key, so a turn runs against whatever `MODEL_BASE_URL`, `MODEL_API_KEY`, and `MODEL_ID` name, on your account, with `MODEL_PROVIDER` naming a protocol other than the OpenAI-compatible default. A server with those unset still boots and still answers every read, and a turn it is asked to run fails saying which variables are missing.

`--url` has no variable of its own because `PORT` says where a server this machine starts listens, and a command may be pointed at a server on another machine. Point it with `--url` and the two stay separate things. The token is a remote-command value for the same reason: it is what a command presents to a server, and `tdg dev` gates nothing.

## One process serves the API and the UI

`tdg dev` boots the server's own application and serves the voyager's build under whatever the API does not own. The API paths are unchanged: the declared routes answer first, and a path none of them matches falls through to the build. A path that names a file is served as that file, and a path that names nothing is served the index when the caller accepts HTML, which is what makes a deep link into the explorer work while a client asking for JSON still reads the problem document.

The build is found rather than configured. A published install carries the assets staged beside the sources at publish time, and inside this repository the build is where vite wrote it, so `bun run --cwd apps/voyager build` is what makes `tdg dev` serve a UI here. A build in neither place is a failure raised before the process listens, naming the command to run and the places that were looked in (`apps/cli/src/assets.ts`, `BUILD_COMMAND`). Hot reload stays the voyager's own dev script: this command serves a build and proxies nothing.

`tdg dev` is the local command: it binds loopback (`DEV_HOST`) and runs ungated, so it takes no token and ignores `TARDIGRADE_TOKEN`, and what keeps it private is the interface it listens on rather than a secret. A server meant to be reachable by anyone else is the server run directly with `TARDIGRADE_TOKEN` set, which [Run the server](server.md) covers; `--token` stays on `ls`, `events`, `run`, and `send`, since those may be pointed at one.

## Running without a model

The server boots without model coordinates and every turn it drives fails with the sentence the server already gives. `tdg dev` boots the same way, and `tdg run` reports that failure as the turn's error and exits non-zero, so the first run is honest rather than silent. Set the three variables and the same brief runs.

## Waiting, and what a retry costs

`tdg send` returns as soon as the server has accepted the event, because an append answers `202` and the turn settles on the server's own loop. `tdg run` waits: it appends, then reads the actor's `turns` projection with `?turn=` every `DEFAULT_POLL_MILLIS` until that turn leaves `pending`, and gives up after `DEFAULT_TIMEOUT_MILLIS` while saying that the turn is still running (`apps/cli/src/commands.ts`). `--poll` and `--timeout` set both. The exit code is zero only when the turn completed.

Both commands mint a message id per invocation unless `--id` states one. The id is the dedup key end to end and becomes the turn id, so an invocation retried with the same `--id` is absorbed rather than started twice, and an invocation retried without one starts a second turn. `tdg run` also mints the thread when `--thread` states none, which births a new thread, since a thread exists once its log has an event.

## Output for people, and for pipes

Every command prints aligned plain text by default and takes `--json`, which prints the client's value verbatim on standard output. There is no colour and there are no icons, so a table reads the same in a terminal, a pager, and a log. `tdg events` cuts its detail column at `DEFAULT_DETAIL_WIDTH` characters and `--width` sets that; `--json` is the rendering with no cut at all.

## Failures

A failed call prints the server's own problem document as its title, its status, and its detail, and exits non-zero. A call that never reached a response prints its title alone, because there is no status to quote. A stack trace is never what a caller sees.

## Shell completions

The tree generates its own completions:

```bash
tdg --completions zsh > ~/.zsh/completions/_tdg
```

`bash`, `fish`, and `sh` are the others. The script it prints carries its own installation note in a comment at the top.
