import { Clock, Console, Effect, Layer, Option } from "effect"
import { Argument, CliError, Command, Flag } from "effect/unstable/cli"
import { NO_ANSWER, ProblemError, type Client, type TurnView } from "@clavia/tardigrade-client"

import { resolveRemote, resolveServer } from "./config"
import { dev } from "./dev"
import { agentsTable, DEFAULT_DETAIL_WIDTH, eventsTable, jsonOf, turnLines } from "./render"
import { Cli } from "./services"

// The command tree. Every command is a declaration: its flags, its arguments, and its description
// are values, so the help a person reads and the completions a shell installs are generated from
// the same tree the parser runs (commands.test.ts). A handler is a few lines over the derived
// client (packages/client) and holds no wire knowledge of its own.

// How often `tdg run` asks whether the turn it delivered has left `pending`. The server answers a
// delivery with 202 and settles the turn on its own loop, so waiting is polling; this is the delay
// a person sees between the turn finishing and the command printing.
export const DEFAULT_POLL_MILLIS = 200

// How long `tdg run` waits before it gives up and says so. A turn that outlives this is still
// running on the server, and its output is still one `tdg events` away, so the number bounds the
// command rather than the work.
export const DEFAULT_TIMEOUT_MILLIS = 300_000

// The turn status a run is asked for. Everything else, `failed` and `parked` alike, leaves the
// command with a non-zero exit: a script that ran an agent and got no answer should not read as
// success (commands.test.ts, "a failed turn prints its error and exits non-zero").
export const SETTLED: TurnView["status"] = "completed"

// problemLine is the whole of what a failed call prints. The four fields are the server's own words
// (packages/client/src/problem.ts), and a status of NO_ANSWER means the call never reached a
// response, so there is no status line to quote.
export const problemLine = (error: ProblemError): string => {
  const where = error.status === NO_ANSWER ? error.title : `${error.title} (${error.status})`
  return error.detail === undefined ? where : `${where}: ${error.detail}`
}

// userErrorOf carries a failure into the CLI's own channel. The runner renders the message and
// leaves the exit code non-zero, so a caller sees the server's sentence rather than a stack trace
// (commands.test.ts, "a problem document prints its title, status, and detail").
const userErrorOf = (cause: unknown): CliError.UserError =>
  new CliError.UserError({
    cause,
    userMessage: cause instanceof ProblemError ? problemLine(cause) : String(cause)
  })

const call = <A>(promise: () => Promise<A>): Effect.Effect<A, CliError.UserError> =>
  Effect.tryPromise({ try: promise, catch: userErrorOf })

// The flags a command that talks to a server takes. They are values rather than a shape repeated
// per command, so `--url` means the same thing everywhere it appears.
const url = Flag.string("url").pipe(
  Flag.withDescription("The server to call. Defaults to the client's own default base URL."),
  Flag.optional
)

const token = Flag.string("token").pipe(
  Flag.withDescription("The bearer token to present. Defaults to TARDIGRADE_TOKEN."),
  Flag.optional
)

const json = Flag.boolean("json").pipe(
  Flag.withDescription("Print the client's value verbatim as JSON instead of a table."),
  Flag.withDefault(false)
)

const messageId = Flag.string("id").pipe(
  Flag.withDescription(
    "The message id, which is also the turn id and the dedup key. A fresh one is minted per invocation, so state it to make a retry absorbed rather than duplicated."
  ),
  Flag.optional
)

const remote = { url, token, json }

// clientOf resolves where to call and opens the client, which is the one place the two sources meet
// (config.ts, resolveRemote).
const clientOf = (flags: {
  readonly url: Option.Option<string>
  readonly token: Option.Option<string>
}) =>
  Effect.map(Cli, (cli) => {
    const resolved = resolveRemote({ url: stated(flags.url), token: stated(flags.token) }, cli.env)
    return cli.openClient({ baseUrl: resolved.baseUrl, token: resolved.token })
  })

const stated = (option: Option.Option<string>): string | undefined => Option.getOrUndefined(option)

const settle = (
  client: Client,
  agent: string,
  turn: string,
  pollMillis: number,
  timeoutMillis: number
): Effect.Effect<TurnView, CliError.UserError> =>
  Effect.gen(function*() {
    const started = yield* Clock.currentTimeMillis
    for (;;) {
      const view = yield* call(() => client.turn(agent, turn))
      if (view.status !== "pending") return view
      if ((yield* Clock.currentTimeMillis) - started >= timeoutMillis) {
        return yield* Effect.fail(
          userErrorOf(
            `turn ${turn} on agent ${agent} was still pending after ${timeoutMillis}ms. It is still running: read it with \`tdg events ${agent}\`.`
          )
        )
      }
      yield* Effect.sleep(pollMillis)
    }
  })

export const devCommand = Command.make("dev", {
  port: Flag.integer("port").pipe(
    Flag.withDescription("The port to listen on. Defaults to PORT, then the server's own default."),
    Flag.optional
  ),
  db: Flag.string("db").pipe(
    Flag.withDescription("The SQLite file that holds every log. Defaults to TARDIGRADE_DB."),
    Flag.optional
  ),
  ui: Flag.string("ui").pipe(
    Flag.withDescription("The directory holding the built UI. Defaults to the build shipped beside this command."),
    Flag.optional
  )
}, (flags) =>
  Effect.flatMap(Cli, (cli) =>
    Effect.flatMap(
      Effect.try({
        try: () =>
          dev({
            config: resolveServer(
              { port: Option.getOrUndefined(flags.port), db: stated(flags.db) },
              cli.env
            ),
            assets: stated(flags.ui)
          }),
        catch: userErrorOf
      }),
      (layer) => Effect.mapError(Layer.launch(layer), userErrorOf)
    ))).pipe(
      Command.withDescription(
        "Boot the API and serve the built UI at one URL, ungated on loopback. One process, one port: the API paths are the server's own and everything else is the UI."
      ),
      Command.withExamples([
        { command: "tdg dev", description: "Listen on PORT, or on the server's default port" },
        { command: "tdg dev --port 8080 --db runs.sqlite", description: "Listen elsewhere, on another store" }
      ])
    )

export const runCommand = Command.make("run", {
  brief: Argument.string("brief").pipe(Argument.withDescription("What to ask the agent to do")),
  agent: Flag.string("agent").pipe(
    Flag.withDescription("The agent to deliver to. A fresh id is minted per invocation, which births a new agent."),
    Flag.optional
  ),
  id: messageId,
  poll: Flag.integer("poll").pipe(
    Flag.withDescription("Milliseconds between turn reads while waiting."),
    Flag.withDefault(DEFAULT_POLL_MILLIS)
  ),
  timeout: Flag.integer("timeout").pipe(
    Flag.withDescription("Milliseconds to wait for the turn to leave pending."),
    Flag.withDefault(DEFAULT_TIMEOUT_MILLIS)
  ),
  ...remote
}, (flags) =>
  Effect.gen(function*() {
    const cli = yield* Cli
    const client = yield* clientOf(flags)
    const agent = stated(flags.agent) ?? cli.mintId()
    const id = stated(flags.id) ?? cli.mintId()
    const accepted = yield* call(() => client.deliver(agent, { id, text: flags.brief }))
    const view = yield* settle(client, accepted.agent, accepted.turn, flags.poll, flags.timeout)
    yield* Console.log(flags.json ? jsonOf(view) : turnLines(accepted.agent, view))
    if (view.status !== SETTLED) {
      return yield* Effect.fail(userErrorOf(`turn ${view.turn} on agent ${accepted.agent} is ${view.status}`))
    }
  })).pipe(
    Command.withDescription(
      "Deliver a brief, wait for the turn to settle, and print what it answered. Exits non-zero unless the turn completed."
    ),
    Command.withExamples([
      { command: "tdg run \"summarize the log\"", description: "Brief a new agent and wait for its answer" },
      { command: "tdg run \"and again\" --agent surveyor", description: "Brief an agent that already exists" }
    ])
  )

export const sendCommand = Command.make("send", {
  agent: Argument.string("agent").pipe(Argument.withDescription("The agent to deliver to")),
  brief: Argument.string("brief").pipe(Argument.withDescription("What to ask the agent to do")),
  id: messageId,
  ...remote
}, (flags) =>
  Effect.gen(function*() {
    const cli = yield* Cli
    const client = yield* clientOf(flags)
    const id = stated(flags.id) ?? cli.mintId()
    const accepted = yield* call(() => client.deliver(flags.agent, { id, text: flags.brief }))
    yield* Console.log(flags.json ? jsonOf(accepted) : `${accepted.agent} ${accepted.turn}`)
  })).pipe(
    Command.withDescription(
      "Deliver a brief and print the turn handle without waiting. The turn settles on the server's own loop."
    )
  )

export const lsCommand = Command.make("ls", remote, (flags) =>
  Effect.gen(function*() {
    const client = yield* clientOf(flags)
    const agents = yield* call(() => client.list())
    yield* Console.log(flags.json ? jsonOf(agents) : agentsTable(agents))
  })).pipe(
    Command.withDescription("List every agent a store holds, parent before child. A spawned child is an agent like any other, so a run that spawned nine lists ten rows."),
    Command.withAlias("list")
  )

export const eventsCommand = Command.make("events", {
  agent: Argument.string("agent").pipe(Argument.withDescription("The agent whose log to read")),
  after: Flag.integer("after").pipe(
    Flag.withDescription("Start past this sequence number. The server numbers events from 1."),
    Flag.optional
  ),
  limit: Flag.integer("limit").pipe(
    Flag.withDescription("Cap the rows read. Defaults to the server's own page size."),
    Flag.optional
  ),
  types: Flag.string("types").pipe(
    Flag.withDescription("Keep only these event types, as a comma list."),
    Flag.optional
  ),
  width: Flag.integer("width").pipe(
    Flag.withDescription("How wide the detail column may run before it is cut."),
    Flag.withDefault(DEFAULT_DETAIL_WIDTH)
  ),
  ...remote
}, (flags) =>
  Effect.gen(function*() {
    const client = yield* clientOf(flags)
    const types = stated(flags.types)?.split(",").map((type) => type.trim()).filter((type) => type.length > 0)
    const rows = yield* call(() =>
      client.events(flags.agent, {
        after: Option.getOrUndefined(flags.after),
        limit: Option.getOrUndefined(flags.limit),
        types
      })
    )
    yield* Console.log(flags.json ? jsonOf(rows) : eventsTable(rows, flags.width))
  })).pipe(
    Command.withDescription("Print an agent's log, one line per event.")
  )

// The root. It has no handler, so `tdg` with no subcommand renders the help the declaration
// generates, and an unknown subcommand fails with the module's own message and a non-zero exit.
export const tdg = Command.make("tdg").pipe(
  Command.withDescription(
    "The tardigrade command. Every read is a projection of a durable log, and every failure is the server's own problem document."
  ),
  Command.withSubcommands([devCommand, runCommand, sendCommand, lsCommand, eventsCommand])
)
