import { Clock, Console, Effect, Layer, Option } from "effect"
import { Argument, CliError, Command, Flag } from "effect/unstable/cli"
import { NO_ANSWER, ProblemError, RESERVED_ACTOR, type Client, type MethodState } from "@clavia/tardigrade-client"

import { modelIsConfigured } from "@clavia/tardigrade-server/host"

import { buildActor, buildSummary, DEFAULT_BUILD_DIRECTORY } from "./build"
import { readFileConfig, readProjectConfig, resolveRemote, resolveServer } from "./config"
import { availableDevPort, DEFAULT_ACTOR_REFRESH_MILLIS, DEFAULT_MIN_PORT, DEV_URL_HOST, dev, openBrowser } from "./dev"
import { initActor, initSummary } from "./init"
import { DEFAULT_ACTOR_DIRECTORY, pushActor, pushSummary, PUSH_TARGETS } from "./push"
import { readSetupEnv, setupAnswersFrom, setupJson, setupPrompt, setupSummary, writeSetup } from "./setup"
import { actorsTable, threadsTable, DEFAULT_DETAIL_WIDTH, eventsTable, jsonOf, methodLines, methodsLines } from "./render"
import { Cli } from "./services"
import { traceUrlFor } from "./workflow"

// The command tree. Every command is a declaration: its flags, its arguments, and its description
// are values, so the help a person reads and the completions a shell installs are generated from
// the same tree the parser runs (commands.test.ts). A handler is a few lines over the derived
// client (packages/client) and holds no wire knowledge of its own.

// DEFAULT_POLL_MILLIS is how often `tdg call` asks whether a method call has left `pending`.
export const DEFAULT_POLL_MILLIS = 200

// DEFAULT_TIMEOUT_MILLIS bounds how long `tdg call` waits while the server continues the work.
export const DEFAULT_TIMEOUT_MILLIS = 300_000

// DEFAULT_OPEN_BROWSER is whether `tdg dev` opens the UI after listening. The `--no-open` flag
// overrides it for scripts, containers, and remote shells.
export const DEFAULT_OPEN_BROWSER = true

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
  CliError.UserError.make({
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

const setupProvider = Flag.string("provider").pipe(
  Flag.withDescription("The provider name used by actor model coordinates."),
  Flag.optional
)

const setupBaseUrl = Flag.string("base-url").pipe(
  Flag.withDescription("The provider API base URL."),
  Flag.optional
)

const setupDriver = Flag.string("driver").pipe(
  Flag.withDescription("The provider protocol driver."),
  Flag.optional
)

const setupCredentialEnv = Flag.string("credential-env").pipe(
  Flag.withDescription("The environment variable holding the provider credential."),
  Flag.optional
)

const setupDefaultModel = Flag.string("default-model").pipe(
  Flag.withDescription("The provider model ID used as the host default."),
  Flag.optional
)

const actor = Flag.string("actor").pipe(
  Flag.withDescription(`The actor to address. Defaults to ${RESERVED_ACTOR}.`),
  Flag.withDefault(RESERVED_ACTOR)
)

const callId = Flag.string("id").pipe(
  Flag.withDescription(
    "The call id. A fresh id is minted unless stated; reuse it for an idempotent retry."
  ),
  Flag.optional
)

const remote = { url, token, actor, json }

// clientOf resolves where to call and opens the client, which is the one place the two sources meet
// (config.ts, resolveRemote).
const clientOf = (flags: {
  readonly url: Option.Option<string>
  readonly token: Option.Option<string>
  readonly actor: string
}) =>
  Effect.gen(function*() {
    const cli = yield* Cli
    const file = yield* readFileConfig(cli.env)
    const resolved = resolveRemote({ url: stated(flags.url), token: stated(flags.token) }, cli.env, file)
    return cli.openClient({ baseUrl: resolved.baseUrl, token: resolved.token, actor: flags.actor })
  })

const stated = (option: Option.Option<string>): string | undefined => Option.getOrUndefined(option)

const methodInput = (source: string): Effect.Effect<unknown, CliError.UserError> =>
  Effect.try({
    try: () => JSON.parse(source) as unknown,
    catch: () => userErrorOf("method input must be valid JSON")
  })

const settle = (
  client: Client,
  thread: string,
  method: string,
  callId: string,
  pollMillis: number,
  timeoutMillis: number
): Effect.Effect<MethodState, CliError.UserError> =>
  Effect.gen(function*() {
    const started = yield* Clock.currentTimeMillis
    for (;;) {
      const state = yield* call(() => client.methodState(thread, method, callId))
      if (state.status !== "pending") return state
      if ((yield* Clock.currentTimeMillis) - started >= timeoutMillis) {
        return yield* userErrorOf(
          `call ${callId} on thread ${thread} was still pending after ${timeoutMillis}ms. It is still running: read it with \`tdg events ${thread}\`.`
        )
      }
      yield* Effect.sleep(pollMillis)
    }
  })

// What `tdg dev` says when no source named a model and nobody can be asked. It names the command
// that fixes it and stops there: the process still boots, still answers every read, and every turn
// it is asked to run fails with the server's own sentence.
export const NO_MODEL_NOTICE =
  "no provider connection is configured, so reads work and turns fail. Run `tdg setup` to configure a provider and default model."

// asking is only honest at a terminal. A boot inside CI, a container, or a script has no one to
// answer, and a prompt there waits forever on input that never arrives, so those boots take the
// notice instead (commands.test.ts, "dev asks only where someone can answer").
const canAsk = (): boolean => process.stdin.isTTY === true

export const NON_INTERACTIVE_SETUP =
  "tdg setup needs all declarative flags when stdin is not interactive; see `tdg setup --help`"
export const NON_INTERACTIVE_INIT =
  "tdg init needs all provider flags when stdin is not interactive; see `tdg init --help`"

export const setupCommand = Command.make("setup", {
  provider: setupProvider,
  baseUrl: setupBaseUrl,
  driver: setupDriver,
  credentialEnv: setupCredentialEnv,
  defaultModel: setupDefaultModel,
  json
}, (flags) =>
  Effect.gen(function*() {
    const cli = yield* Cli
    const declared = yield* Effect.try({
      try: () => setupAnswersFrom({
        provider: stated(flags.provider),
        baseUrl: stated(flags.baseUrl),
        driver: stated(flags.driver),
        credentialEnv: stated(flags.credentialEnv),
        defaultModel: stated(flags.defaultModel)
      }, cli.env),
      catch: userErrorOf
    })
    const answers = declared ?? (canAsk()
      ? yield* Effect.mapError(setupPrompt(), userErrorOf)
      : yield* userErrorOf(NON_INTERACTIVE_SETUP))
    const files = yield* Effect.mapError(writeSetup(cli.cwd, answers, cli.env), userErrorOf)
    yield* Console.log(flags.json ? jsonOf(setupJson(files, answers)) : setupSummary(files, answers))
  })).pipe(
    Command.withDescription(
      "Ask for a provider connection and default model, then update tardigrade.jsonc and store the credential in .env at 0600."
    ),
    Command.withExamples([
      { command: "tdg setup", description: "Prompt for a provider and credential" },
      {
        command: "tdg setup --provider openrouter --base-url https://openrouter.ai/api/v1 --driver openai-chat-completions --credential-env OPENROUTER_API_KEY --default-model anthropic/claude-sonnet-4-6",
        description: "Configure a provider from explicit values"
      }
    ])
  )

export const initCommand = Command.make("init", {
  name: Argument.string("name").pipe(Argument.withDescription("The actor name")),
  dir: Flag.string("dir").pipe(
    Flag.withDescription("The directory to create. Defaults to a directory named after the actor."),
    Flag.optional
  ),
  force: Flag.boolean("force").pipe(
    Flag.withDescription("Replace actor.ts when it already exists."),
    Flag.withDefault(false)
  ),
  provider: setupProvider,
  baseUrl: setupBaseUrl,
  driver: setupDriver,
  credentialEnv: setupCredentialEnv,
  defaultModel: setupDefaultModel,
  json
}, (flags) =>
  Effect.gen(function*() {
    const cli = yield* Cli
    const directory = stated(flags.dir)
    const declared = yield* Effect.try({
      try: () => setupAnswersFrom({
        provider: stated(flags.provider),
        baseUrl: stated(flags.baseUrl),
        driver: stated(flags.driver),
        credentialEnv: stated(flags.credentialEnv),
        defaultModel: stated(flags.defaultModel)
      }, cli.env, "tdg init"),
      catch: userErrorOf
    })
    const answers = declared ?? (canAsk()
      ? yield* Effect.mapError(setupPrompt(), userErrorOf)
      : yield* userErrorOf(NON_INTERACTIVE_INIT))
    const initialized = yield* Effect.tryPromise({
      try: () => initActor(flags.name, {
        cwd: cli.cwd,
        ...(directory === undefined ? {} : { directory }),
        model: { provider: answers.provider, defaultModel: answers.model_id },
        force: flags.force
      }),
      catch: userErrorOf
    })
    const files = yield* Effect.mapError(writeSetup(initialized.directory, answers, cli.env), userErrorOf)
    yield* Console.log(flags.json
      ? jsonOf({ ...initialized, setup: setupJson(files, answers) })
      : `${setupSummary(files, answers)}\n\n${initSummary(initialized, cli.cwd)}`)
  })).pipe(
    Command.withDescription("Create an editable actor and configure its first provider connection."),
    Command.withExamples([
      { command: "tdg init researcher", description: "Choose a provider and create a ready actor" },
      {
        command: "tdg init researcher --provider openrouter --base-url https://openrouter.ai/api/v1 --driver openai-chat-completions --credential-env OPENROUTER_API_KEY --default-model anthropic/claude-sonnet-4-6",
        description: "Create a ready actor from explicit values"
      }
    ])
  )

export const buildCommand = Command.make("build", {
  entry: Argument.string("entry").pipe(Argument.withDescription("The actor source file to bundle")),
  out: Flag.string("out").pipe(
    Flag.withDescription(`The artifact root. Defaults to ${DEFAULT_BUILD_DIRECTORY}.`),
    Flag.optional
  ),
  json
}, (flags) =>
  Effect.gen(function*() {
    const out = stated(flags.out)
    const built = yield* Effect.tryPromise({
      try: () => buildActor(flags.entry, out === undefined ? {} : { out }),
      catch: userErrorOf
    })
    yield* Console.log(flags.json ? jsonOf(built) : buildSummary(built, flags.entry))
  })).pipe(
    Command.withDescription("Bundle and validate one named actor as a portable artifact."),
    Command.withExamples([
      { command: "tdg build ./actors/researcher.ts", description: "Build one actor into the default artifact root" }
    ])
  )

export const pushCommand = Command.make("push", {
  entry: Argument.string("entry").pipe(Argument.withDescription("The actor source file to build and push")),
  target: Flag.choice("target", PUSH_TARGETS).pipe(
    Flag.withDescription("Where to push the actor. State local or hosted explicitly.")
  ),
  out: Flag.string("out").pipe(
    Flag.withDescription(`The artifact root. Defaults to ${DEFAULT_BUILD_DIRECTORY}.`),
    Flag.optional
  ),
  actors: Flag.string("actors").pipe(
    Flag.withDescription(`The local actor root. Defaults to ${DEFAULT_ACTOR_DIRECTORY}.`),
    Flag.optional
  ),
  url,
  token,
  json
}, (flags) =>
  Effect.gen(function*() {
    const cli = yield* Cli
    const file = yield* readFileConfig(cli.env)
    const resolved = flags.target === "hosted"
      ? resolveRemote({ url: stated(flags.url), token: stated(flags.token) }, cli.env, file)
      : undefined
    const out = stated(flags.out)
    const actors = stated(flags.actors)
    const pushed = yield* Effect.tryPromise({
      try: () => pushActor(flags.entry, {
        target: flags.target,
        ...(out === undefined ? {} : { out }),
        ...(actors === undefined ? {} : { actors }),
        ...(resolved === undefined ? {} : { baseUrl: resolved.baseUrl }),
        ...(resolved?.token === undefined ? {} : { token: resolved.token })
      }),
      catch: userErrorOf
    })
    yield* Console.log(flags.json ? jsonOf(pushed) : pushSummary(pushed))
  })).pipe(
    Command.withDescription("Build one named actor and push the same artifact to a local or hosted actor root."),
    Command.withExamples([
      { command: "tdg push ./actors/researcher.ts --target local", description: "Push an actor into the local actor root" },
      { command: "tdg push ./actors/researcher.ts --target hosted --url https://api.example.com", description: "Push an actor to a hosted server" }
    ])
  )

export const devCommand = Command.make("dev", {
  port: Flag.integer("port").pipe(
    Flag.withDescription("The port to listen on. Defaults to PORT, then the server's own default."),
    Flag.optional
  ),
  minPort: Flag.integer("min-port").pipe(
    Flag.withDescription("The lowest automatic fallback when the implicit default port is occupied."),
    Flag.withDefault(DEFAULT_MIN_PORT)
  ),
  db: Flag.string("db").pipe(
    Flag.withDescription("The SQLite file that holds every log. Defaults to TARDIGRADE_DB."),
    Flag.optional
  ),
  actors: Flag.string("actors").pipe(
    Flag.withDescription("The directory holding pushed actors. Defaults to TARDIGRADE_ACTORS."),
    Flag.optional
  ),
  actorData: Flag.string("actor-data").pipe(
    Flag.withDescription("The directory holding pushed actor databases. Defaults to TARDIGRADE_ACTOR_DATA."),
    Flag.optional
  ),
  maxConcurrentLanes: Flag.integer("max-concurrent-lanes").pipe(
    Flag.withDescription("The maximum actor lanes settled at once. Defaults to TARDIGRADE_MAX_CONCURRENT_LANES."),
    Flag.optional
  ),
  actorRefreshMillis: Flag.integer("actor-refresh-ms").pipe(
    Flag.withDescription("Milliseconds to wait after a local actor change before refreshing the registry."),
    Flag.withDefault(DEFAULT_ACTOR_REFRESH_MILLIS)
  ),
  ui: Flag.string("ui").pipe(
    Flag.withDescription("The directory holding the built UI. Defaults to the build shipped beside this command."),
    Flag.optional
  ),
  open: Flag.boolean("open").pipe(
    Flag.withDescription("Open the UI in the default browser after the server starts. Use --no-open to keep it closed."),
    Flag.withDefault(DEFAULT_OPEN_BROWSER)
  )
}, (flags) =>
  Effect.gen(function*() {
    const cli = yield* Cli
    const project = yield* Effect.mapError(readProjectConfig(cli.cwd, cli.env), userErrorOf)
    const config = yield* Effect.try({
      try: () => resolveServer({
        port: Option.getOrUndefined(flags.port),
        db: stated(flags.db),
        actors: stated(flags.actors),
        actorData: stated(flags.actorData),
        maxConcurrentLanes: Option.getOrUndefined(flags.maxConcurrentLanes)
      }, cli.env, project),
      catch: userErrorOf
    })
    // A first boot with no model asks for one, because two commands to see anything is one too
    // many. Away from a terminal it says the notice and serves anyway: every read is a projection
    // of a log and none of them needs a model, so a server with no model is a useful server that
    // cannot run a turn (apps/server/src/host.ts, MISSING_MODEL).
    const asked = yield* modelIsConfigured(config)
      ? Effect.succeed(config)
      : canAsk()
      ? Effect.gen(function*() {
        const answers = yield* Effect.mapError(setupPrompt(), userErrorOf)
        const files = yield* Effect.mapError(writeSetup(cli.cwd, answers, cli.env), userErrorOf)
        yield* Console.log(setupSummary(files, answers))
        const written = yield* readSetupEnv(cli.cwd)
        const writtenProject = yield* Effect.mapError(readProjectConfig(cli.cwd, cli.env), userErrorOf)
        return yield* Effect.try({
          try: () => resolveServer({
            port: Option.getOrUndefined(flags.port),
            db: stated(flags.db),
            actors: stated(flags.actors),
            actorData: stated(flags.actorData),
            maxConcurrentLanes: Option.getOrUndefined(flags.maxConcurrentLanes)
          }, { ...cli.env, ...written }, writtenProject),
          catch: userErrorOf
        })
      })
      : Effect.as(Console.log(NO_MODEL_NOTICE), config)
    const portWasStated = Option.isSome(flags.port) || (cli.env["PORT"]?.trim().length ?? 0) > 0
    const selectedPort = portWasStated
      ? asked.port
      : yield* Effect.tryPromise({
        try: () => availableDevPort(asked.port, flags.minPort),
        catch: userErrorOf
      })
    if (selectedPort !== asked.port) {
      yield* Console.log(`port ${asked.port} is busy; using http://${DEV_URL_HOST}:${selectedPort}`)
    }
    const config2 = selectedPort === asked.port ? asked : { ...asked, port: selectedPort }
    const layer = yield* Effect.try({
      try: () => dev({
        config: config2,
        assets: stated(flags.ui),
        actorRefreshMillis: flags.actorRefreshMillis,
        ...(flags.open ? { onListen: openBrowser } : {})
      }),
      catch: userErrorOf
    })
    return yield* Effect.mapError(Layer.launch(layer), userErrorOf)
  })).pipe(
      Command.withDescription(
        "Boot the API and serve the built UI at one URL, ungated on loopback. One process, one port: the API paths are the server's own and everything else is the UI."
      ),
      Command.withExamples([
        { command: "tdg dev", description: "Listen on PORT, or find a free port from the server's default" },
        { command: "tdg dev --port 8080 --db runs.sqlite", description: "Listen elsewhere, on another store" }
      ])
    )

export const methodsCommand = Command.make("methods", remote, (flags) =>
  Effect.gen(function*() {
    const client = yield* clientOf(flags)
    const methods = yield* call(() => client.methods())
    yield* Console.log(flags.json ? jsonOf(methods) : methodsLines(methods))
  })).pipe(
    Command.withDescription("List method names and their input and output schemas."),
    Command.withExamples([
      { command: "tdg methods --actor researcher", description: "Inspect an actor's callable interface" },
      { command: "tdg methods --actor researcher --json", description: "Print the method catalog as JSON" }
    ])
  )

export const callCommand = Command.make("call", {
  method: Argument.string("method").pipe(Argument.withDescription("The declared method to call")),
  input: Argument.string("input").pipe(Argument.withDescription("The method input as JSON")),
  thread: Flag.string("thread").pipe(
    Flag.withDescription("The thread id. A fresh id is minted unless stated."),
    Flag.optional
  ),
  id: callId,
  wait: Flag.boolean("wait").pipe(
    Flag.withDescription("Wait for the method call to leave pending."),
    Flag.withDefault(true)
  ),
  poll: Flag.integer("poll").pipe(
    Flag.withDescription("Milliseconds between method state reads while waiting."),
    Flag.withDefault(DEFAULT_POLL_MILLIS)
  ),
  timeout: Flag.integer("timeout").pipe(
    Flag.withDescription("Milliseconds to wait for the method call to leave pending."),
    Flag.withDefault(DEFAULT_TIMEOUT_MILLIS)
  ),
  ...remote
}, (flags) =>
  Effect.gen(function*() {
    const cli = yield* Cli
    const client = yield* clientOf(flags)
    const thread = stated(flags.thread) ?? cli.mintId()
    const id = stated(flags.id) ?? cli.mintId()
    const input = yield* methodInput(flags.input)
    const accepted = yield* call(() => client.invoke(thread, flags.method, { id, input }))
    if (!flags.wait) {
      yield* Console.log(flags.json ? jsonOf(accepted) : `${accepted.thread} ${accepted.call} accepted`)
      return
    }
    const state = yield* settle(client, accepted.thread, accepted.method, accepted.call, flags.poll, flags.timeout)
    yield* Console.log(
      flags.json
        ? jsonOf({ ...accepted, ...state })
        : state.status === "completed"
        ? `${methodLines(accepted.thread, accepted.call, state)}\n\ntrace\n  ${traceUrlFor(client.baseUrl, client.actor, accepted.thread)}`
        : methodLines(accepted.thread, accepted.call, state)
    )
    if (state.status !== "completed") {
      return yield* userErrorOf(`call ${accepted.call} on thread ${accepted.thread} is ${state.status}`)
    }
  })).pipe(
    Command.withDescription("Call an actor method with JSON input. Waits by default and exits non-zero unless completed."),
    Command.withExamples([
      { command: "tdg call message '{\"text\":\"summarize the log\"}'", description: "Call message on a new thread and wait" },
      { command: "tdg call message '{\"text\":\"and again\"}' --thread surveyor", description: "Call message on an existing thread" }
    ])
  )

export const lsCommand = Command.make("ls", remote, (flags) =>
  Effect.gen(function*() {
    const client = yield* clientOf(flags)
    const threads = yield* call(() => client.list())
    yield* Console.log(flags.json ? jsonOf(threads) : threadsTable(threads))
  })).pipe(
    Command.withDescription("List every thread a store holds, parent before child. An execution that spawned nine children lists ten rows."),
    Command.withAlias("list")
  )

export const actorsCommand = Command.make("actors", { url, token, json }, (flags) =>
  Effect.gen(function*() {
    const client = yield* clientOf({ ...flags, actor: RESERVED_ACTOR })
    const actors = yield* call(() => client.actors())
    yield* Console.log(flags.json ? jsonOf(actors) : actorsTable(actors))
  })).pipe(
    Command.withDescription("List every actor available on the server."),
    Command.withExamples([
      { command: "tdg actors", description: "List actors as a table" },
      { command: "tdg actors --json", description: "Print the actor summaries as JSON" }
    ])
  )

export const eventsCommand = Command.make("events", {
  thread: Argument.string("thread").pipe(Argument.withDescription("The thread whose log to read")),
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
      client.events(flags.thread, {
        after: Option.getOrUndefined(flags.after),
        limit: Option.getOrUndefined(flags.limit),
        types
      })
    )
    yield* Console.log(flags.json ? jsonOf(rows) : eventsTable(rows, flags.width))
  })).pipe(
    Command.withDescription("Print a thread's log, one line per event.")
  )

// The root. It has no handler, so `tdg` with no subcommand renders the help the declaration
// generates, and an unknown subcommand fails with the module's own message and a non-zero exit.
export const tdg = Command.make("tdg").pipe(
  Command.withDescription(
    "The tardigrade command. Every read is a projection of a durable log, and every failure is the server's own problem document."
  ),
  Command.withSubcommands([initCommand, setupCommand, buildCommand, pushCommand, devCommand, actorsCommand, methodsCommand, callCommand, lsCommand, eventsCommand])
)
