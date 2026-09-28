import { Console, Effect, Option, Queue } from "effect"
import { Command, Flag, Prompt } from "effect/unstable/cli"
import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { sendMessage, observeMessages } from "./chat"
import { createPermissions, DEFAULT_PERMISSION_MODE, PERMISSION_MODES, type Permissions } from "./permissions"
import { chatPrompt } from "./prompt"
import { DEFAULT_MAX_CHILD_DEPTH } from "./services"
import { DEFAULT_BATCH_SIZE, DEFAULT_POLL_MS, DEFAULT_WATCH_WIDTH, watchLog } from "./watch"
import { DEFAULT_THREAD_DIRECTORY, DEFAULT_INSTANCE, activeThread, activateThread, findThread, listThreads, hostScope, type ChatHost, type ChatThread, type ThreadOptions, type ThreadListing } from "./threads"

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: RuntimeError.from })
const directory = Flag.String("thread-dir").pipe(Flag.withDefault(DEFAULT_THREAD_DIRECTORY), Flag.withDescription("Directory containing host thread storage."))
const instance = Flag.String("instance").pipe(Flag.withDefault(DEFAULT_INSTANCE), Flag.withDescription("Actor instance whose threads to use."))
const thread = Flag.String("thread").pipe(Flag.optional, Flag.withDescription("Resume a thread by name or ID."))
const maxChildDepth = Flag.Int("max-child-depth").pipe(Flag.withDefault(DEFAULT_MAX_CHILD_DEPTH), Flag.withDescription("Maximum child-agent nesting depth; 0 disables delegation."))
const permissionMode = Flag.Literals("permissions", PERMISSION_MODES).pipe(Flag.withDefault(DEFAULT_PERMISSION_MODE), Flag.withDescription("Tool permissions: ask each time, auto allows read-only tools, full-access allows all tools."))
const message = Flag.String("message").pipe(Flag.optional, Flag.withDescription("Send one message, print the answer, and exit without prompts."))
const threadLabel = (item: ThreadListing) => `${item.name}  ·  ${item.status}  ·  last activity ${item.lastActivity === undefined ? "none" : new Date(item.lastActivity).toLocaleString()}`

const selectThread = (options: ThreadOptions, message: string) => Effect.gen(function* () {
  const threads = yield* attempt(() => listThreads(options))
  if (!threads.length) return yield* Effect.fail(new RuntimeError("No saved threads. Start a chat first."))
  const active = yield* attempt(() => activeThread(options))
  return yield* Prompt.Select({ message, choices: threads.map(value => ({ title: `${threadLabel(value)}${value.coordinate.thread === active?.thread ? "  (active)" : ""}`, value: value.coordinate })) })
})

const printThreads = (options: ThreadOptions) => Effect.gen(function* () {
  const threads = yield* attempt(() => listThreads(options))
  const active = yield* attempt(() => activeThread(options))
  yield* Console.log(threads.length ? threads.map(item => `${item.coordinate.thread === active?.thread ? "*" : " "} ${threadLabel(item)}  (${item.coordinate.thread})`).join("\n") : "No saved threads.")
})

const watch = Command.make("watch", {
  thread, directory, instance,
  active: Flag.Boolean("active").pipe(Flag.withDefault(false), Flag.withDescription("Follow the active chat across thread switches without a picker.")),
  after: Flag.Int("after").pipe(Flag.withDefault(-1), Flag.withDescription("Show events after this sequence; -1 shows the entire log.")),
  poll: Flag.Int("poll").pipe(Flag.withDefault(DEFAULT_POLL_MS), Flag.withDescription("Journal refresh interval in milliseconds.")),
  batchSize: Flag.Int("batch-size").pipe(Flag.withDefault(DEFAULT_BATCH_SIZE), Flag.withDescription("Maximum events printed per batch; all batches are printed.")),
  once: Flag.Boolean("once").pipe(Flag.withDefault(false), Flag.withDescription("Print stored events and exit.")),
  json: Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Print one JSON object per event.")),
  width: Flag.Int("width").pipe(Flag.optional, Flag.withDescription(`Row width in columns; defaults to terminal width or ${DEFAULT_WATCH_WIDTH} when redirected.`)),
}, options => Effect.gen(function* () {
  if (options.active && Option.isSome(options.thread)) return yield* Effect.fail(new RuntimeError("Use either --active or --thread"))
  if (!options.active && Option.isNone(options.thread) && !process.stdin.isTTY) return yield* Effect.fail(new RuntimeError("Choose --thread or --active when stdin is not a terminal"))
  const coordinate = Option.isSome(options.thread)
    ? yield* attempt(() => findThread(options, Option.getOrThrow(options.thread)))
    : options.active ? undefined : yield* selectThread(options, "Watch thread")
  yield* watchLog({
    ...options,
    storage: options.directory,
    coordinate,
    resolveThread: () => activeThread(options),
    width: Option.getOrUndefined(options.width),
  })
}).pipe(Effect.catchTag("QuitError", () => Effect.void))).pipe(Command.withDescription("Choose a thread and watch its event log without running its actor."))

const threadsCommand = Command.make("threads", { directory, instance }, printThreads).pipe(Command.withDescription("List threads from the supervisor store."))

const newThread = (host: ChatHost, options: ThreadOptions, name?: string) => attempt(async () => {
  const supervisor = await host.supervisorStore(options.instance)
  if (name && supervisor.threads.get().some(thread => thread.parent === null && thread.name === name)) throw new RuntimeError(`Thread already exists: ${name}. Use /switch to resume it.`)
  return host.allocateRootThread({ instance: options.instance, ...(name ? { name } : {}) })
})

const resumeThread = (host: ChatHost, coordinate: { readonly instance: string; readonly thread: string }) => attempt(async () => {
  const thread = await host.getThread(coordinate)
  if (!thread) throw new RuntimeError(`Thread is not registered: ${coordinate.thread}`)
  return thread
})

const chat = (host: ChatHost, selected: ChatThread, options: ThreadOptions & { readonly permissions: Permissions }) => Effect.scoped(Effect.gen(function* () {
  const inbox = yield* observeMessages(selected)
  yield* Effect.acquireRelease(
    Effect.sync(() => options.permissions.subscribe(notice => { Queue.offerUnsafe(inbox, notice) })),
    unsubscribe => Effect.sync(unsubscribe),
  )
  yield* attempt(() => selected.resume()).pipe(Effect.catch(error => Queue.offer(inbox, { seq: -1, kind: "error", text: error.message })), Effect.forkScoped)
  yield* attempt(() => activateThread(options, selected.coordinate))
  yield* Console.log(`Thread: ${selected.coordinate.thread}\nPermissions: ${options.permissions.mode()}\n/new [name]  /threads  /switch [name]  /permissions [mode]  /approvals  /allow <id>  /deny <id>  /exit`)
  while (true) {
    const text = yield* chatPrompt(inbox)
    const input = text.trim()
    if (input === "/exit") return undefined
    if (!input) continue
    if (input === "/threads") { yield* printThreads(options); continue }
    if (input === "/help") { yield* Console.log("/new [name]  /threads  /switch [name]  /permissions [ask|auto|full-access]  /approvals  /allow <id>  /deny <id>  /exit"); continue }
    if (input === "/approvals") {
      const pending = options.permissions.list()
      if (!pending.length) yield* Console.log("No pending approvals.")
      for (const notice of pending) yield* Queue.offer(inbox, notice)
      continue
    }
    if (/^\/(allow|deny)(?:\s|$)/.test(input)) {
      const [command, id] = input.split(/\s+/)
      yield* Effect.try({ try: () => options.permissions.decide(id ?? "", command === "/allow"), catch: RuntimeError.from }).pipe(Effect.catch(error => Effect.logError(error.message)))
      continue
    }
    if (/^\/permissions(?:\s|$)/.test(input)) {
      yield* Effect.gen(function* () {
        const value = input.slice("/permissions".length).trim()
        const next = value || (yield* Prompt.Select({ message: "Tool permissions", choices: PERMISSION_MODES.map(mode => ({ title: mode, value: mode })) }))
        const mode = PERMISSION_MODES.find(mode => mode === next)
        if (!mode) return yield* Effect.fail(new RuntimeError("Choose ask, auto, or full-access"))
        yield* options.permissions.change(mode).pipe(Effect.mapError(RuntimeError.from))
        yield* Console.log(`Permissions: ${mode}. Pending approvals still require /allow or /deny.`)
      }).pipe(Effect.catchTag("RuntimeError", error => Effect.logError(error.message)))
      continue
    }
    if (/^\/(new|switch)(?:\s|$)/.test(input)) {
      const next = yield* Effect.gen(function* () {
        const [command, ...parts] = input.split(/\s+/)
        const name = parts.join(" ") || undefined
        if (command === "/new") return yield* newThread(host, options, name)
        const coordinate = name ? yield* attempt(() => findThread(options, name)) : yield* selectThread(options, "Switch thread")
        return yield* resumeThread(host, coordinate)
      }).pipe(Effect.catchTag("RuntimeError", error => Effect.as(Effect.logError(error.message), undefined)))
      if (next) return next
      continue
    }
    if (input.startsWith("/")) { yield* Console.log("Unknown command. Type /help for thread commands."); continue }
    yield* sendMessage(selected, text).pipe(
      Effect.catch(error => Queue.offer(inbox, { seq: -1, kind: "error", text: error.message })),
      Effect.forkScoped,
    )
  }
}))

export const cli = Command.make("experimental-chat", { thread, directory, instance, message, maxChildDepth, permissionMode }, flags => Effect.scoped(Effect.gen(function* () {
  const options = { ...flags, permissions: createPermissions({ mode: flags.permissionMode, interactive: Option.isNone(flags.message) && !!process.stdin.isTTY }) }
  if (!Number.isSafeInteger(options.maxChildDepth) || options.maxChildDepth < 0) return yield* Effect.fail(new RuntimeError("--max-child-depth must be a nonnegative integer"))
  if (Option.isSome(options.message) && !options.message.value.trim()) return yield* Effect.fail(new RuntimeError("--message must not be empty"))
  if (Option.isNone(options.message) && !process.stdin.isTTY) return yield* Effect.fail(new RuntimeError("Use --message to chat without an interactive terminal"))
  const host = yield* hostScope(options)
  const selected = Option.isSome(options.thread)
    ? yield* resumeThread(host, yield* attempt(() => findThread(options, Option.getOrThrow(options.thread))))
    : yield* newThread(host, options)
  if (Option.isSome(options.message)) {
    yield* attempt(async () => { await selected.resume(); await selected.wait() })
    yield* attempt(() => activateThread(options, selected.coordinate))
    yield* Console.error(`Thread: ${selected.coordinate.thread}\nPermissions: ${options.permissions.mode()}`)
    const replies = yield* sendMessage(selected, options.message.value)
    for (const reply of replies) {
      if (reply.outcome !== "completed") return yield* Effect.fail(new RuntimeError(reply.text))
      yield* Console.log(reply.text)
    }
    return
  }
  let current: ChatThread | undefined = selected
  while (current) current = yield* chat(host, current, options)
})).pipe(Effect.catchTag("QuitError", () => Effect.void))).pipe(
  Command.withDescription("Start a fresh thread, resume with --thread, or send once with --message."),
  Command.withSubcommands([watch, threadsCommand]),
)
