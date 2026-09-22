import { modelConfigOf } from "@clavia/tardigrade-model/config"
import { Clock, Console, Effect, Option } from "effect"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import { Argument, CliError, Command, Flag, Prompt } from "effect/unstable/cli"
import { ACTOR_NAME_PATTERN } from "tardie"
import {
  CATALOG_AVAILABILITY_FILTERS,
  MODEL_CATALOG_PRICE_SORTS,
  MODEL_CATALOG_SORT_ORDERS,
  MODEL_CATALOG_UNPRICED_ORDERS,
  NO_ANSWER,
  ProblemError,
  type ActorClient,
  type ActorCallHandle,
  type MethodState
} from "@clavia/tardigrade-client"

import { modelCatalogConfigOf, type ModelConfig } from "@clavia/tardigrade-server/config"

import { buildActor, buildSummary, DEFAULT_BUILD_DIRECTORY, lintActor, lintSummary } from "./build"
import { readFileConfig, readProjectConfig, resolveRemote } from "./config"
import { DEFAULT_INIT_ACTOR_NAME, defaultInitDirectory, initActor, initSummary, terminalColorsEnabled } from "./init"
import { withLoader } from "./loader"
import { resolveModelLock, writeModelLock } from "./model-lock"
import { DEFAULT_INIT_TEMPLATE, INIT_TEMPLATES } from "./template"
import {
  defaultModelFrom,
  defaultSetupJson,
  defaultSetupSummary,
  providerAnswersFrom,
  providerConfigWithAnswers,
  providerSetupJson,
  providerSetupSummary,
  setupAnswersFrom,
  setupDefaultPrompt,
  setupFlowPrompt,
  setupJson,
  setupPlanSummary,
  setupPrompt,
  setupProviderPrompt,
  setupSummary,
  type ProviderAnswers,
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
import { Cli, type CliServices } from "./services"

// The command tree. Every command is a declaration: its flags, its arguments, and its description
// are values, so the help a person reads and the completions a shell installs are generated from
// the same tree the parser runs (commands.test.ts). A handler is a few lines over the derived
// client (packages/client) and holds no wire knowledge of its own.

// DEFAULT_POLL_MILLIS is how often `tdg call` asks whether a method call has left `pending`.
export const DEFAULT_POLL_MILLIS = 200

// DEFAULT_TIMEOUT_MILLIS bounds how long `tdg call` waits while the server continues the work.
export const DEFAULT_TIMEOUT_MILLIS = 300_000

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
const url = Flag.String("url").pipe(
  Flag.withDescription("The server to call. Defaults to the client's own default base URL."),
  Flag.optional
)

const token = Flag.String("token").pipe(
  Flag.withDescription("The bearer token to present. Defaults to TARDIGRADE_TOKEN."),
  Flag.optional
)

const json = Flag.Boolean("json").pipe(
  Flag.withDescription("Print the client's value verbatim as JSON instead of a table."),
  Flag.withDefault(false)
)

const setupProvider = Flag.String("provider").pipe(
  Flag.withDescription("The provider name used by actor model references."),
  Flag.optional
)

const setupProviderConfig = Flag.String("provider-config").pipe(
  Flag.withDescription("The provider connection as JSON. Secret values stay in environment variables."),
  Flag.optional
)

const setupDefaultModel = Flag.String("default-model").pipe(
  Flag.withDescription("The provider model ID used as the host default."),
  Flag.optional
)

const setupModel = Flag.String("model").pipe(
  Flag.withDescription("The provider model ID used as the host default."),
  Flag.optional
)

const callId = Flag.String("id").pipe(
  Flag.withDescription(
    "The call id. A fresh id is minted unless stated; reuse it for an idempotent retry."
  ),
  Flag.optional
)

const actorInstance = Flag.String("actor").pipe(
  Flag.withDescription("The actor instance id."),
  Flag.withDefault("main")
)

const remote = { url, token, json, actor: actorInstance }
const catalogRemote = { url, token, json }

const catalogSearch = Flag.String("search").pipe(
  Flag.withDescription("Keep entries whose ID or name contains this text."),
  Flag.optional
)

const catalogCursor = Flag.String("cursor").pipe(
  Flag.withDescription("Continue from a cursor returned by the same catalog query."),
  Flag.optional
)

const catalogLimit = Flag.Int("limit").pipe(
  Flag.withDescription("The page size. Defaults to the server's catalog page size."),
  Flag.optional
)

const catalogAvailability = Flag.Literals("availability", CATALOG_AVAILABILITY_FILTERS).pipe(
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
  handle: ActorCallHandle,
  pollMillis: number,
  timeoutMillis: number
): Effect.Effect<MethodState, CliError.UserError> =>
  Effect.gen(function*() {
    const started = yield* Clock.currentTimeMillis
    for (;;) {
      const state = yield* call(() => client.state(handle))
      if (state.status !== "pending") return state
      if ((yield* Clock.currentTimeMillis) - started >= timeoutMillis) {
        return yield* userErrorOf(
          `call ${handle.id} on thread ${handle.thread} was still pending after ${timeoutMillis}ms. It is still running: read it with \`tdg events ${handle.thread}\`.`
        )
      }
      yield* Effect.sleep(pollMillis)
    }
  })

// canAsk limits interactive authoring to terminals.
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

const configuredModels = (
  current: ModelConfig,
  providers: ReadonlyArray<ProviderAnswers>,
  selected: ModelConfig["default"] = current.default
): ModelConfig => modelConfigOf({
  allow: current.allow,
  ...(selected === undefined ? {} : { default: selected }),
  providers: {
    ...current.providers,
    ...Object.fromEntries(providers.map((provider) => [
      provider.provider, providerConfigWithAnswers(current.providers[provider.provider], provider)
    ]))
  }
})

const resolveConfiguredModelLock = (cli: CliServices, models: ModelConfig) => Effect.gen(function*() {
  const catalog = modelCatalogConfigOf(cli.env)
  return yield* Effect.tryPromise({
    try: () => resolveModelLock(models, {
      sourceUrl: catalog.sourceUrl,
      cachePath: resolve(cli.cwd, catalog.cachePath),
      timeoutMillis: catalog.timeoutMillis,
      fetch: cli.fetch
    }),
    catch: userErrorOf
  })
})

const persistModelLock = (cli: CliServices, lock: Awaited<ReturnType<typeof resolveModelLock>>) =>
  Effect.tryPromise({
    try: () => writeModelLock(cli.cwd, lock),
    catch: userErrorOf
  })

const writeSetupWithLock = <A, E, R>(
  cli: CliServices,
  models: ModelConfig,
  write: Effect.Effect<A, E, R>
) => Effect.gen(function*() {
  const lock = yield* resolveConfiguredModelLock(cli, models)
  const files = yield* write
  return [files, yield* persistModelLock(cli, lock)] as const
})

const setupOutput = (asJson: boolean, value: object, summary: string, modelLock: string): string =>
  asJson ? jsonOf({ ...value, modelLock }) : `${summary}\nwrote ${modelLock}`

export const setupProviderCommand = Command.make("provider", {
  provider: Argument.String("provider").pipe(
    Argument.withDescription("The provider name used by actor model references."),
    Argument.optional
  ),
  config: Argument.String("config").pipe(
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
    const [files, modelLock] = yield* writeSetupWithLock(
      cli,
      configuredModels(project.models, [answers]),
      Effect.mapError(writeProviderSetup(cli.cwd, [answers], cli.env), userErrorOf)
    )
    yield* Console.log(setupOutput(
      flags.json,
      providerSetupJson(files, [answers]),
      providerSetupSummary(files, [answers]),
      modelLock
    ))
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
  const selected: { readonly provider: string; readonly model_id: string; readonly models?: ProviderAnswers["models"] } = declared ?? (canAsk()
    ? yield* Effect.mapError(setupDefaultPrompt(Object.keys(project.models.providers), {
      ...setupPromptOptionsIn(cli.cwd, cli.env),
      providers: project.models.providers,
      ...(project.models.default === undefined ? {} : { current: project.models.default })
    }), userErrorOf)
    : yield* userErrorOf(NON_INTERACTIVE_DEFAULT_SETUP))
  if (project.models.providers[selected.provider] === undefined) {
    return yield* userErrorOf(`provider ${JSON.stringify(selected.provider)} is not configured; run \`tdg setup provider\``)
  }
  const updates: ReadonlyArray<ProviderAnswers> = selected.models === undefined ? [] : [{
    ...project.models.providers[selected.provider]!, provider: selected.provider, models: selected.models
  }]
  const reference = { provider: selected.provider, model_id: selected.model_id }
  const [files, modelLock] = yield* writeSetupWithLock(
    cli,
    configuredModels(project.models, updates, reference),
    Effect.mapError(updates.length === 0 ? writeDefaultSetup(cli.cwd, reference, cli.env) : writeSetupPlan(cli.cwd, { providers: updates, default: reference }, cli.env), userErrorOf)
  )
  yield* Console.log(setupOutput(flags.json, defaultSetupJson(files, selected), defaultSetupSummary(files, selected), modelLock))
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
    const project = yield* Effect.mapError(readProjectConfig(cli.cwd, cli.env), userErrorOf)
    const selected = { provider: declared.provider, model_id: declared.model_id }
    const [files, modelLock] = yield* writeSetupWithLock(
      cli,
      configuredModels(project.models, [declared], selected),
      Effect.mapError(writeSetup(cli.cwd, declared, cli.env), userErrorOf)
    )
    yield* Console.log(setupOutput(flags.json, setupJson(files, declared), setupSummary(files, declared), modelLock))
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
  const [files, modelLock] = yield* writeSetupWithLock(
    cli,
    configuredModels(project.models, plan.providers, plan.default),
    Effect.mapError(writeSetupPlan(cli.cwd, plan, cli.env), userErrorOf)
  )
  yield* Console.log(setupOutput(false, {}, setupPlanSummary(files, plan), modelLock))
})).pipe(
  Command.withDescription("Configure project providers and a default model in the platform manifests. Entered credentials are stored in .dev.vars at 0600."),
  Command.withExamples([{
    command: "tdg setup --provider openrouter --provider-config '{\"env\":[\"OPENROUTER_API_KEY\"]}' --default-model anthropic/claude-sonnet-4.6",
    description: "Configure the first provider and default atomically"
  }]),
  Command.withSubcommands([setupProviderCommand, setupDefaultCommand])
)

export const initCommand = Command.make("init", {
  name: Argument.String("name").pipe(
    Argument.withDescription("The actor name. Prompted when omitted from an interactive terminal."),
    Argument.optional
  ),
  dir: Flag.String("dir").pipe(
    Flag.withDescription("The directory to create. Defaults to a directory named after the actor."),
    Flag.optional
  ),
  template: Flag.Literals("template", INIT_TEMPLATES).pipe(
    Flag.withDescription(`The actor template. Defaults to ${DEFAULT_INIT_TEMPLATE}.`),
    Flag.withDefault(DEFAULT_INIT_TEMPLATE)
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
      ? yield* Prompt.String({
        message: "Actor name",
        default: DEFAULT_INIT_ACTOR_NAME,
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
    const selected = { provider: answers.provider, model_id: answers.model_id }
    const modelLock = yield* resolveConfiguredModelLock(cli, configuredModels({ allow: "*", providers: {} }, [answers], selected))
    const initialized = yield* Effect.tryPromise({
      try: () => initActor(name, {
        cwd: cli.cwd,
        ...(directory === undefined ? {} : { directory }),
        template: flags.template,
        modelProtocol: answers.protocol,
        modelProvider: answers.provider,
        modelLock
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
  entry: Argument.String("entry").pipe(Argument.withDescription("The actor source file to bundle")),
  out: Flag.String("out").pipe(
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
  entry: Argument.String("entry").pipe(Argument.withDescription("The actor source file to validate")),
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

const invocationThread = Flag.String("thread").pipe(
  Flag.withDescription("The thread that owns the invocation.")
)

const invocationRefOf = (flags: {
  readonly actor: string
  readonly thread: string
  readonly method: string
  readonly invocation: string
}) => ({
  actor: flags.actor,
  thread: flags.thread,
  method: flags.method,
  id: flags.invocation
})

export const callStateCommand = Command.make("state", {
  method: Argument.String("method").pipe(Argument.withDescription("The invoked method")),
  invocation: Argument.String("invocation").pipe(Argument.withDescription("The invocation id")),
  thread: invocationThread,
  ...remote
}, (flags) =>
  Effect.gen(function*() {
    const client = yield* clientOf(flags)
    const invocation = invocationRefOf(flags)
    const state = yield* call(() => client.state(invocation))
    yield* Console.log(
      flags.json
        ? jsonOf({ ...invocation, ...state })
        : methodLines(flags.thread, flags.invocation, state)
    )
  })).pipe(
    Command.withDescription("Read one method invocation's durable state."),
    Command.withExamples([{
      command: "tdg call state message m1 --thread root",
      description: "Read invocation m1"
    }])
  )

export const callCancelCommand = Command.make("cancel", {
  method: Argument.String("method").pipe(Argument.withDescription("The invoked method")),
  invocation: Argument.String("invocation").pipe(Argument.withDescription("The invocation id")),
  thread: invocationThread,
  reason: Flag.String("reason").pipe(
    Flag.withDescription("Why the invocation should stop."),
    Flag.optional
  ),
  ...remote
}, (flags) =>
  Effect.gen(function*() {
    const client = yield* clientOf(flags)
    const invocation = invocationRefOf(flags)
    const reason = stated(flags.reason)
    const cancellation = yield* call(() => client.cancel(
      invocation,
      reason === undefined ? undefined : { reason }
    ))
    yield* Console.log(
      flags.json
        ? jsonOf(cancellation)
        : `${cancellation.thread} ${cancellation.call} cancellation ${cancellation.status}`
    )
  })).pipe(
    Command.withDescription("Request cancellation of one method invocation."),
    Command.withExamples([{
      command: "tdg call cancel message m1 --thread root --reason 'operator stopped it'",
      description: "Cancel invocation m1"
    }])
  )

export const threadCreateCommand = Command.make("create", {
  name: Flag.String("name").pipe(
    Flag.withDescription("An instance-scoped root name. Omit to generate a friendly name."),
    Flag.optional
  ),
  ...remote
}, (flags) => Effect.gen(function*() {
  const client = yield* clientOf(flags)
  const coordinate = yield* call(() => client.allocateRoot(flags.actor, stated(flags.name)))
  yield* Console.log(flags.json ? jsonOf(coordinate) : coordinate.thread)
})).pipe(Command.withDescription("Allocate a root thread and print its assigned identity."))

// threadForkCommand names the checkpoint by row or by event id, never both (commands.test.ts, "fork").
export const threadForkCommand = Command.make("fork", {
  thread: Argument.String("thread").pipe(Argument.withDescription("The source thread whose rows are copied")),
  seq: Flag.Int("seq").pipe(
    Flag.withDescription("The source row to copy through, 1-based."),
    Flag.optional
  ),
  event: Flag.String("event").pipe(
    Flag.withDescription("The id of the source event to copy through. A repeated id, such as a callId, names its last row."),
    Flag.optional
  ),
  name: Flag.String("name").pipe(
    Flag.withDescription("The destination root name. Omit to generate an assigned identity."),
    Flag.optional
  ),
  ...remote
}, (flags) => Effect.gen(function*() {
  const seq = Option.getOrUndefined(flags.seq)
  const event = stated(flags.event)
  if ((seq === undefined) === (event === undefined)) {
    return yield* CliError.UserError.make({
      cause: new Error("checkpoint"),
      userMessage: "Pass exactly one of --seq <row> or --event <id>."
    })
  }
  const checkpoint = seq === undefined ? { event: event! } : { seq }
  const client = yield* clientOf(flags)
  const forked = yield* call(() => client.forkThread(flags.actor, flags.thread, checkpoint, stated(flags.name)))
  yield* Console.log(flags.json ? jsonOf(forked) : forked.thread)
})).pipe(
  Command.withDescription("Copy a thread's rows through a checkpoint onto a new root."),
  Command.withExamples([
    { command: "tdg thread fork root --event m1 --name experiment", description: "Fork root through event m1 onto experiment" },
    { command: "tdg thread fork root --seq 2 --json", description: "Fork root through row 2 and print the coordinate" }
  ])
)

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Allocate actor threads."),
  Command.withSubcommands([threadCreateCommand, threadForkCommand])
)

export const callCommand = Command.make("call", {
  method: Argument.String("method").pipe(Argument.withDescription("The declared method to call")),
  input: Argument.String("input").pipe(Argument.withDescription("The method input as JSON")),
  thread: Flag.String("thread").pipe(
    Flag.withDescription("An existing thread id. Omit to allocate a new root."),
    Flag.optional
  ),
  id: callId,
  wait: Flag.Boolean("wait").pipe(
    Flag.withDescription("Wait for the method call to leave pending."),
    Flag.withDefault(true)
  ),
  poll: Flag.Int("poll").pipe(
    Flag.withDescription("Milliseconds between method state reads while waiting."),
    Flag.withDefault(DEFAULT_POLL_MILLIS)
  ),
  timeout: Flag.Int("timeout").pipe(
    Flag.withDescription("Milliseconds to wait for the method call to leave pending."),
    Flag.withDefault(DEFAULT_TIMEOUT_MILLIS)
  ),
  ...remote
}, (flags) =>
  Effect.gen(function*() {
    const cli = yield* Cli
    const client = yield* clientOf(flags)
    const input = yield* methodInput(flags.input)
    const thread = stated(flags.thread) ?? (yield* call(() => client.allocateRoot(flags.actor))).thread
    const id = stated(flags.id) ?? cli.mintId()
    const accepted = yield* call(() => client.call(flags.actor, thread, flags.method, { id, input }))
    if (!flags.wait) {
      yield* Console.log(flags.json ? jsonOf(accepted) : `${accepted.thread} ${accepted.id} accepted`)
      return
    }
    const state = yield* settle(client, accepted, flags.poll, flags.timeout)
    yield* Console.log(
      flags.json
        ? jsonOf({ ...accepted, ...state })
        : methodLines(accepted.thread, accepted.id, state)
    )
    if (state.status !== "completed") {
      return yield* userErrorOf(`call ${accepted.id} on thread ${accepted.thread} is ${state.status}`)
    }
  })).pipe(
    Command.withDescription("Call an actor method with JSON input. Waits by default and exits non-zero unless completed."),
    Command.withExamples([
      { command: "tdg call message '{\"text\":\"summarize the log\"}'", description: "Call message on a new thread and wait" },
      { command: "tdg call message '{\"text\":\"and again\"}' --thread surveyor", description: "Call message on an existing thread" }
    ]),
    Command.withSubcommands([callStateCommand, callCancelCommand])
  )

export const lsCommand = Command.make("ls", remote, (flags) =>
  Effect.gen(function*() {
    const client = yield* clientOf(flags)
    const threads = yield* call(() => client.list(flags.actor))
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

export const modelLockCommand = Command.make("lock", { json }, (flags) =>
  Effect.gen(function*() {
    const cli = yield* Cli
    const project = yield* Effect.mapError(readProjectConfig(cli.cwd, cli.env), userErrorOf)
    const catalog = modelCatalogConfigOf(cli.env)
    const lock = yield* Effect.tryPromise({
      try: () => resolveModelLock(project.models, {
        sourceUrl: catalog.sourceUrl,
        cachePath: resolve(cli.cwd, catalog.cachePath),
        timeoutMillis: catalog.timeoutMillis,
        fetch: cli.fetch
      }),
      catch: userErrorOf
    })
    const path = yield* Effect.tryPromise({
      try: () => writeModelLock(cli.cwd, lock),
      catch: userErrorOf
    })
    yield* Console.log(flags.json ? jsonOf({ path, ...lock }) : `locked ${Object.keys(lock.providers).length} providers at ${path}`)
  })).pipe(
    Command.withDescription("Resolve configured models from the public catalog into the deployment lock."),
    Command.withExamples([{ command: "tdg models lock", description: "Update the deployment model lock" }])
  )

export const modelsCommand = Command.make("models", {
  provider: Flag.String("provider").pipe(
    Flag.withDescription("Keep models from this provider."),
    Flag.optional
  ),
  search: catalogSearch,
  availability: catalogAvailability,
  sort: Flag.Literals("sort", MODEL_CATALOG_PRICE_SORTS).pipe(
    Flag.withDescription("Order models by this token price."),
    Flag.optional
  ),
  order: Flag.Literals("order", MODEL_CATALOG_SORT_ORDERS).pipe(
    Flag.withDescription("Order selected prices from low to high or high to low."),
    Flag.optional
  ),
  unpriced: Flag.Literals("unpriced", MODEL_CATALOG_UNPRICED_ORDERS).pipe(
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
    ]),
    Command.withSubcommands([modelLockCommand])
  )

export const eventsCommand = Command.make("events", {
  thread: Argument.String("thread").pipe(Argument.withDescription("The thread whose log to read")),
  after: Flag.Int("after").pipe(
    Flag.withDescription("Start past this sequence number. The server numbers events from 1."),
    Flag.optional
  ),
  limit: Flag.Int("limit").pipe(
    Flag.withDescription("Cap the rows read. Defaults to the server's own page size."),
    Flag.optional
  ),
  types: Flag.String("types").pipe(
    Flag.withDescription("Keep only these event types, as a comma list."),
    Flag.optional
  ),
  width: Flag.Int("width").pipe(
    Flag.withDescription("How wide the detail column may run before it is cut."),
    Flag.withDefault(DEFAULT_DETAIL_WIDTH)
  ),
  ...remote
}, (flags) =>
  Effect.gen(function*() {
    const client = yield* clientOf(flags)
    const types = stated(flags.types)?.split(",").map((type) => type.trim()).filter((type) => type.length > 0)
    const rows = yield* call(() =>
      client.events(flags.actor, flags.thread, {
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
    { group: "RUN", commands: [threadCommand, callCommand] },
    { group: "CATALOG", commands: [providersCommand, modelsCommand, methodsCommand] },
    { group: "INSPECT", commands: [lsCommand, eventsCommand] }
  ])
)
