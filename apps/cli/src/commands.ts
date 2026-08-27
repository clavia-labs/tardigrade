import { Clock, Console, Effect, Layer, Option } from "effect"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import { Argument, CliError, Command, Flag, Prompt } from "effect/unstable/cli"
import { ACTOR_NAME_PATTERN, type Actor } from "tardie"
import {
  CATALOG_AVAILABILITY_FILTERS,
  MODEL_CATALOG_PRICE_SORTS,
  MODEL_CATALOG_SORT_ORDERS,
  MODEL_CATALOG_UNPRICED_ORDERS,
  NO_ANSWER,
  ProblemError,
  type ActorClient,
  type MethodState
} from "@clavia/tardigrade-client"

import type { ServerR } from "@clavia/tardigrade-server/actor"
import { modelIsConfigured } from "@clavia/tardigrade-server/host"
import { modelCatalogConfigOf } from "@clavia/tardigrade-server/config"

import { buildActor, buildSummary, DEFAULT_BUILD_DIRECTORY, lintActor, lintSummary, loadBuiltActor } from "./build"
import { readFileConfig, readProjectConfig, resolveRemote, resolveServer } from "./config"
import { availableDevPort, DEFAULT_MIN_PORT, DEV_URL_HOST, dev, openBrowser } from "./dev"
import { DEFAULT_ACTOR_ENTRY, defaultInitDirectory, initActor, initSummary, terminalColorsEnabled } from "./init"
import { withLoader } from "./loader"
import {
  defaultModelFrom,
  defaultSetupJson,
  defaultSetupSummary,
  providerAnswersFrom,
  providerSetupJson,
  providerSetupSummary,
  readSetupEnv,
  runtimeEnvironmentOf,
  setupAnswersFrom,
  setupDefaultPrompt,
  setupFlowPrompt,
  setupJson,
  setupPlanSummary,
  setupPrompt,
  setupProviderPrompt,
  setupSummary,
  writeDefaultSetup,
  writeProviderSetup,
  writeSetup,
  writeSetupPlan
} from "./setup"
import {
  DEFAULT_DETAIL_WIDTH,
  eventsTable,
  jsonOf,
  methodLines,
  methodsLines,
  modelsTable,
  providersTable,
  threadsTable
} from "./render"
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

const removeIncompleteProject = (
  directory: string,
  error: CliError.UserError
): Effect.Effect<never, CliError.UserError> =>
  Effect.tryPromise({
    try: () => rm(directory, { recursive: true, force: true }),
    catch: userErrorOf
  }).pipe(
    Effect.catch((cause) => userErrorOf(`${error.message}\ncould not remove incomplete project at ${directory}: ${cause.message}`)),
    Effect.flatMap(() => userErrorOf(`${error.message}\nremoved incomplete project at ${directory}`))
  )

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
  Flag.withDescription("The provider name used by actor model references."),
  Flag.optional
)

const setupProviderConfig = Flag.string("provider-config").pipe(
  Flag.withDescription("The provider connection as JSON. Secret values stay in environment variables."),
  Flag.optional
)

const setupDefaultModel = Flag.string("default-model").pipe(
  Flag.withDescription("The provider model ID used as the host default."),
  Flag.optional
)

const setupModel = Flag.string("model").pipe(
  Flag.withDescription("The provider model ID used as the host default."),
  Flag.optional
)

const callId = Flag.string("id").pipe(
  Flag.withDescription(
    "The call id. A fresh id is minted unless stated; reuse it for an idempotent retry."
  ),
  Flag.optional
)

const remote = { url, token, json }
const catalogRemote = { url, token, json }

const catalogSearch = Flag.string("search").pipe(
  Flag.withDescription("Keep entries whose ID or name contains this text."),
  Flag.optional
)

const catalogCursor = Flag.string("cursor").pipe(
  Flag.withDescription("Continue from a cursor returned by the same catalog query."),
  Flag.optional
)

const catalogLimit = Flag.integer("limit").pipe(
  Flag.withDescription("The page size. Defaults to the server's catalog page size."),
  Flag.optional
)

const catalogAvailability = Flag.choice("availability", CATALOG_AVAILABILITY_FILTERS).pipe(
  Flag.withDescription("Include every catalog provider or only providers this host can use."),
  Flag.optional
)

// clientOf resolves where to call and opens the client, which is the one place the two sources meet
// (config.ts, resolveRemote).
const clientOf = (flags: {
  readonly url: Option.Option<string>
  readonly token: Option.Option<string>
}) =>
  Effect.gen(function*() {
    const cli = yield* Cli
    const file = yield* readFileConfig(cli.env)
    const resolved = resolveRemote({ url: stated(flags.url), token: stated(flags.token) }, cli.env, file)
    return cli.openClient({ baseUrl: resolved.baseUrl, token: resolved.token })
  })

const stated = (option: Option.Option<string>): string | undefined => Option.getOrUndefined(option)

const methodInput = (source: string): Effect.Effect<unknown, CliError.UserError> =>
  Effect.try({
    try: () => JSON.parse(source) as unknown,
    catch: () => userErrorOf("method input must be valid JSON")
  })

const settle = (
  client: ActorClient,
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

const setupPromptOptionsIn = (root: string, env: Readonly<Record<string, string | undefined>>) => {
  const catalog = modelCatalogConfigOf(env)
  return {
    catalog: {
      cachePath: resolve(root, catalog.cachePath),
      timeoutMillis: catalog.timeoutMillis,
      url: catalog.sourceUrl
    }
  }
}

const setupPromptIn = (root: string, env: Readonly<Record<string, string | undefined>>) =>
  setupPrompt(setupPromptOptionsIn(root, env))

export const NON_INTERACTIVE_SETUP =
  "tdg setup needs --provider, --provider-config, and --default-model when stdin is not interactive; see `tdg setup --help`"
export const NON_INTERACTIVE_PROVIDER_SETUP =
  "tdg setup provider needs <provider> and <config> when stdin is not interactive; see `tdg setup provider --help`"
export const NON_INTERACTIVE_DEFAULT_SETUP =
  "tdg setup default needs --provider and --model when stdin is not interactive; see `tdg setup default --help`"
export const NON_INTERACTIVE_INIT =
  "tdg init needs --provider, --provider-config, and --default-model when stdin is not interactive; see `tdg init --help`"
export const NON_INTERACTIVE_INIT_NAME =
  "tdg init needs <name> when stdin is not interactive; see `tdg init --help`"

export const setupProviderCommand = Command.make("provider", {
  provider: Argument.string("provider").pipe(
    Argument.withDescription("The provider name used by actor model references."),
    Argument.optional
  ),
  config: Argument.string("config").pipe(
    Argument.withDescription("The provider connection as JSON. Secret values stay in environment variables."),
    Argument.optional
  ),
  json
}, (flags) =>
  Effect.gen(function*() {
    const cli = yield* Cli
    const project = yield* Effect.mapError(readProjectConfig(cli.cwd, cli.env), userErrorOf)
    if (project.models.default === undefined) {
      return yield* userErrorOf("the first provider and default must be configured together; run `tdg setup`")
    }
    const declared = yield* Effect.try({
      try: () => providerAnswersFrom({
        provider: stated(flags.provider),
        config: stated(flags.config)
      }),
      catch: userErrorOf
    })
    const answers = declared ?? (canAsk()
      ? yield* Effect.mapError(setupProviderPrompt(setupPromptOptionsIn(cli.cwd, cli.env)), userErrorOf)
      : yield* userErrorOf(NON_INTERACTIVE_PROVIDER_SETUP))
    const files = yield* Effect.mapError(writeProviderSetup(cli.cwd, [answers], cli.env), userErrorOf)
    yield* Console.log(flags.json
      ? jsonOf(providerSetupJson(files, [answers]))
      : providerSetupSummary(files, [answers]))
  })).pipe(
    Command.withDescription(
      "Add or update one provider connection after the host default is configured."
    ),
    Command.withExamples([
      { command: "tdg setup provider", description: "Prompt for a provider connection" },
      {
        command: "tdg setup provider openrouter '{\"env\":[\"OPENROUTER_API_KEY\"]}'",
        description: "Add a provider from JSON"
      }
    ])
  )

export const setupDefaultCommand = Command.make("default", {
  provider: setupProvider,
  model: setupModel,
  json
}, (flags) => Effect.gen(function*() {
  const cli = yield* Cli
  const project = yield* Effect.mapError(readProjectConfig(cli.cwd, cli.env), userErrorOf)
  const declared = yield* Effect.try({
    try: () => defaultModelFrom({ provider: stated(flags.provider), model: stated(flags.model) }),
    catch: userErrorOf
  })
  const selected = declared ?? (canAsk()
    ? yield* Effect.mapError(setupDefaultPrompt(Object.keys(project.models.providers), {
      ...setupPromptOptionsIn(cli.cwd, cli.env),
      ...(project.models.default === undefined ? {} : { current: project.models.default })
    }), userErrorOf)
    : yield* userErrorOf(NON_INTERACTIVE_DEFAULT_SETUP))
  if (project.models.providers[selected.provider] === undefined) {
    return yield* userErrorOf(`provider ${JSON.stringify(selected.provider)} is not configured; run \`tdg setup provider\``)
  }
  const files = yield* Effect.mapError(writeDefaultSetup(cli.cwd, selected, cli.env), userErrorOf)
  yield* Console.log(flags.json ? jsonOf(defaultSetupJson(files, selected)) : defaultSetupSummary(files, selected))
})).pipe(
  Command.withDescription("Choose the default model from configured provider connections."),
  Command.withExamples([
    { command: "tdg setup default", description: "Choose the default provider and model" },
    { command: "tdg setup default --provider openrouter --model anthropic/claude-sonnet-4.6", description: "Select a default from explicit values" }
  ])
)

export const setupCommand = Command.make("setup", {
  provider: setupProvider,
  providerConfig: setupProviderConfig,
  defaultModel: setupDefaultModel,
  json
}, (flags) => Effect.gen(function*() {
  const declared = yield* Effect.try({
    try: () => setupAnswersFrom({
      provider: stated(flags.provider),
      providerConfig: stated(flags.providerConfig),
      defaultModel: stated(flags.defaultModel)
    }),
    catch: userErrorOf
  })
  if (declared !== undefined) {
    const cli = yield* Cli
    const files = yield* Effect.mapError(writeSetup(cli.cwd, declared, cli.env), userErrorOf)
    yield* Console.log(flags.json ? jsonOf(setupJson(files, declared)) : setupSummary(files, declared))
    return
  }
  if (!canAsk()) return yield* userErrorOf(NON_INTERACTIVE_SETUP)
  const cli = yield* Cli
  const project = yield* Effect.mapError(readProjectConfig(cli.cwd, cli.env), userErrorOf)
  const plan = yield* Effect.mapError(setupFlowPrompt({
    ...setupPromptOptionsIn(cli.cwd, cli.env),
    existing: project.models
  }), userErrorOf)
  if (plan === undefined) {
    yield* Console.log("setup cancelled")
    return
  }
  const files = yield* Effect.mapError(writeSetupPlan(cli.cwd, plan, cli.env), userErrorOf)
  yield* Console.log(setupPlanSummary(files, plan))
})).pipe(
  Command.withDescription("Configure project providers and a default model in the platform manifests. Entered credentials are stored in .dev.vars at 0600."),
  Command.withExamples([{
    command: "tdg setup --provider openrouter --provider-config '{\"env\":[\"OPENROUTER_API_KEY\"]}' --default-model anthropic/claude-sonnet-4.6",
    description: "Configure the first provider and default atomically"
  }]),
  Command.withSubcommands([setupProviderCommand, setupDefaultCommand])
)

export const initCommand = Command.make("init", {
  name: Argument.string("name").pipe(
    Argument.withDescription("The actor name. Prompted when omitted from an interactive terminal."),
    Argument.optional
  ),
  dir: Flag.string("dir").pipe(
    Flag.withDescription("The directory to create. Defaults to a directory named after the actor."),
    Flag.optional
  ),
  provider: setupProvider,
  providerConfig: setupProviderConfig,
  defaultModel: setupDefaultModel,
  json
}, (flags) =>
  Effect.gen(function*() {
    const cli = yield* Cli
    const declaredName = stated(flags.name)
    const name = declaredName ?? (canAsk()
      ? yield* Prompt.text({
        message: "Actor name",
        validate: (value) => {
          const candidate = value.trim()
          return ACTOR_NAME_PATTERN.test(candidate)
            ? Effect.succeed(candidate)
            : Effect.fail(`actor name must match ${String(ACTOR_NAME_PATTERN)}`)
        }
      })
      : yield* userErrorOf(NON_INTERACTIVE_INIT_NAME))
    const directory = stated(flags.dir)
    const initializedRoot = resolve(cli.cwd, directory ?? defaultInitDirectory(name))
    if (existsSync(initializedRoot)) {
      return yield* userErrorOf(`init target already exists at ${initializedRoot}. Choose a new directory.`)
    }
    const declared = yield* Effect.try({
      try: () => setupAnswersFrom({
        provider: stated(flags.provider),
        providerConfig: stated(flags.providerConfig),
        defaultModel: stated(flags.defaultModel)
      }, "tdg init"),
      catch: userErrorOf
    })
    const answers = declared ?? (canAsk()
      ? yield* Effect.mapError(setupPromptIn(cli.cwd, cli.env), userErrorOf)
      : yield* userErrorOf(NON_INTERACTIVE_INIT))
    const initialized = yield* Effect.tryPromise({
      try: () => initActor(name, {
        cwd: cli.cwd,
        ...(directory === undefined ? {} : { directory })
      }),
      catch: userErrorOf
    })
    yield* Effect.gen(function*() {
      yield* Effect.tryPromise({
        try: () => withLoader(
          "Installing dependencies",
          () => cli.installProject(initialized.directory),
          { enabled: flags.json === false && process.stdout.isTTY === true }
        ),
        catch: userErrorOf
      })
      const files = yield* Effect.mapError(writeSetup(initialized.directory, answers, cli.env), userErrorOf)
      yield* Console.log(flags.json
        ? jsonOf({ ...initialized, setup: setupJson(files, answers) })
        : initSummary(initialized, files, answers, {
          colors: terminalColorsEnabled(cli.env),
          cwd: cli.cwd
        }))
    }).pipe(Effect.catch((error) => removeIncompleteProject(initialized.directory, error)))
  })).pipe(
    Command.withDescription("Create an editable actor and configure its first provider connection."),
    Command.withExamples([
      { command: "tdg init", description: "Choose an actor name and provider interactively" },
      { command: "tdg init researcher", description: "Choose a provider and create a ready actor" },
      {
        command: "tdg init researcher --provider openrouter --provider-config '{\"env\":[\"OPENROUTER_API_KEY\"]}' --default-model anthropic/claude-sonnet-4.6",
        description: "Create a ready actor from provider JSON"
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
    yield* Console.log(flags.json ? jsonOf(built) : buildSummary(built))
  })).pipe(
    Command.withDescription("Bundle and validate one named actor as a portable artifact."),
    Command.withExamples([
      { command: "tdg build ./actors/researcher.ts", description: "Build one actor into the default artifact root" }
    ])
  )

export const lintCommand = Command.make("lint", {
  entry: Argument.string("entry").pipe(Argument.withDescription("The actor source file to validate")),
  json
}, (flags) =>
  Effect.gen(function*() {
    const cli = yield* Cli
    const linted = yield* Effect.tryPromise({
      try: () => lintActor(flags.entry, { cwd: cli.cwd }),
      catch: userErrorOf
    })
    yield* Console.log(flags.json ? jsonOf(linted) : lintSummary(linted))
  })).pipe(
    Command.withDescription("Validate an actor's component and method seams without writing an artifact."),
    Command.withExamples([
      { command: "tdg lint actor.ts", description: "Check one actor before building or deploying it" }
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
  maxConcurrentLanes: Flag.integer("max-concurrent-lanes").pipe(
    Flag.withDescription("The maximum actor lanes settled at once. Defaults to TARDIGRADE_MAX_CONCURRENT_LANES."),
    Flag.optional
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
    const localSecrets = yield* readSetupEnv(cli.cwd)
    const runtimeEnv = runtimeEnvironmentOf(cli.env, localSecrets)
    const project = yield* Effect.mapError(readProjectConfig(cli.cwd, runtimeEnv), userErrorOf)
    const config = yield* Effect.try({
      try: () => resolveServer({
        port: Option.getOrUndefined(flags.port),
        db: stated(flags.db),
        maxConcurrentLanes: Option.getOrUndefined(flags.maxConcurrentLanes)
      }, runtimeEnv, project),
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
        const answers = yield* Effect.mapError(setupPromptIn(cli.cwd, runtimeEnv), userErrorOf)
        const files = yield* Effect.mapError(writeSetup(cli.cwd, answers, runtimeEnv), userErrorOf)
        yield* Console.log(setupSummary(files, answers))
        const written = yield* readSetupEnv(cli.cwd)
        const writtenProject = yield* Effect.mapError(readProjectConfig(cli.cwd, runtimeEnv), userErrorOf)
        return yield* Effect.try({
          try: () => resolveServer({
            port: Option.getOrUndefined(flags.port),
            db: stated(flags.db),
            maxConcurrentLanes: Option.getOrUndefined(flags.maxConcurrentLanes)
          }, runtimeEnvironmentOf(cli.env, written), writtenProject),
          catch: userErrorOf
        })
      })
      : Effect.as(Console.log(NO_MODEL_NOTICE), config)
    const portWasStated = Option.isSome(flags.port) || (runtimeEnv["PORT"]?.trim().length ?? 0) > 0
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
    const built = yield* Effect.tryPromise({
      try: () => buildActor(DEFAULT_ACTOR_ENTRY, { cwd: cli.cwd }),
      catch: userErrorOf
    })
    const definition = yield* Effect.tryPromise({
      try: () => loadBuiltActor(built),
      catch: userErrorOf
    })
    const layer = yield* Effect.try({
      try: () => dev({
        config: config2,
        actor: definition as Actor<ServerR>,
        assets: stated(flags.ui),
        ...(flags.open ? { onListen: openBrowser } : {})
      }),
      catch: userErrorOf
    })
    return yield* Effect.mapError(Layer.launch(layer), userErrorOf)
  })).pipe(
      Command.withDescription(
        "Build actor.ts, boot its API, and serve the built UI at one loopback URL."
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
      { command: "tdg methods", description: "Inspect the mounted actor's callable interface" },
      { command: "tdg methods --json", description: "Print the method catalog as JSON" }
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
        ? `${methodLines(accepted.thread, accepted.call, state)}\n\ntrace\n  ${traceUrlFor(client.baseUrl, accepted.thread)}`
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

export const providersCommand = Command.make("providers", {
  search: catalogSearch,
  availability: catalogAvailability,
  cursor: catalogCursor,
  limit: catalogLimit,
  ...catalogRemote
}, (flags) =>
  Effect.gen(function*() {
    const client = yield* clientOf(flags)
    const page = yield* call(() => client.providers({
      availability: Option.getOrUndefined(flags.availability),
      cursor: stated(flags.cursor),
      limit: Option.getOrUndefined(flags.limit),
      search: stated(flags.search)
    }))
    yield* Console.log(flags.json ? jsonOf(page) : providersTable(page))
  })).pipe(
    Command.withDescription("List provider protocols, endpoints, credential names, and required configuration."),
    Command.withExamples([
      { command: "tdg providers", description: "List the first provider page" },
      { command: "tdg providers --search google --json", description: "Search providers and print the page as JSON" }
    ])
  )

export const modelsCommand = Command.make("models", {
  provider: Flag.string("provider").pipe(
    Flag.withDescription("Keep models from this provider."),
    Flag.optional
  ),
  search: catalogSearch,
  availability: catalogAvailability,
  sort: Flag.choice("sort", MODEL_CATALOG_PRICE_SORTS).pipe(
    Flag.withDescription("Order models by this token price."),
    Flag.optional
  ),
  order: Flag.choice("order", MODEL_CATALOG_SORT_ORDERS).pipe(
    Flag.withDescription("Order selected prices from low to high or high to low."),
    Flag.optional
  ),
  unpriced: Flag.choice("unpriced", MODEL_CATALOG_UNPRICED_ORDERS).pipe(
    Flag.withDescription("Place models without the selected price first or last."),
    Flag.optional
  ),
  cursor: catalogCursor,
  limit: catalogLimit,
  ...catalogRemote
}, (flags) =>
  Effect.gen(function*() {
    const client = yield* clientOf(flags)
    const page = yield* call(() => client.models({
      availability: Option.getOrUndefined(flags.availability),
      cursor: stated(flags.cursor),
      limit: Option.getOrUndefined(flags.limit),
      provider: stated(flags.provider),
      search: stated(flags.search),
      sort: Option.getOrUndefined(flags.sort),
      order: Option.getOrUndefined(flags.order),
      unpriced: Option.getOrUndefined(flags.unpriced)
    }))
    yield* Console.log(flags.json ? jsonOf(page) : modelsTable(page))
  })).pipe(
    Command.withDescription("Search and page the public model catalog."),
    Command.withExamples([
      { command: "tdg models --provider openrouter --search claude", description: "Search OpenRouter models" },
      { command: "tdg models --sort completionUsdPerToken --order asc", description: "List the cheapest completion prices first" },
      { command: "tdg models --cursor <cursor> --json", description: "Read the next page as JSON" }
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
  Command.withDescription("Build, run, and inspect durable actors."),
  Command.withSubcommands([
    { group: "CREATE", commands: [initCommand, setupCommand, lintCommand, buildCommand] },
    { group: "RUN", commands: [devCommand, callCommand] },
    { group: "CATALOG", commands: [providersCommand, modelsCommand, methodsCommand] },
    { group: "INSPECT", commands: [lsCommand, eventsCommand] }
  ])
)
