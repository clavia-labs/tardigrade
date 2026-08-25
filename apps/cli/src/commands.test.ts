import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Console, Effect, Exit, Layer, Option } from "effect"
import { CliError, Command } from "effect/unstable/cli"
import { BunServices } from "@effect/platform-bun"
import {
  ProblemError,
  RESERVED_ACTOR,
  type ActorSummary,
  type Client,
  type EventRow,
  type MethodAccepted,
  type MethodState,
  type MethodSummary,
  type ModelCatalogPage,
  type ProviderCatalogPage,
  type ThreadSummary
} from "@clavia/tardigrade-client"

import { NO_MODEL_NOTICE, problemLine, tdg } from "./commands"
import { Cli, type CliServices } from "./services"

// The command tree, driven the way a shell drives it: real arguments through the real parser, over
// a client this file wrote. Nothing here spawns a process, and nothing here reaches a network.

const threads: ReadonlyArray<ThreadSummary> = [
  { id: "root", depth: 0, events: 2, lastAt: 0, status: "settled" }
]

const events: ReadonlyArray<EventRow> = [
  { seq: 1, event: { type: "MessageReceived", text: "hello" } },
  { seq: 2, event: { type: "TurnCompleted", output: "ok" } }
]

interface Recorded {
  readonly invoked: Array<{ thread: string; method: string; id: string; input: unknown }>
  readonly asked: Array<{ thread: string; options: unknown }>
  readonly catalog: Array<{ kind: "models" | "providers"; options: unknown }>
  readonly installed: Array<string>
  methodReads: number
}

const refuse = () => Promise.reject(new Error("this command should not have called that"))

// A client whose answers are stated per case. Its methods are the derived client's own, so a
// handler that compiles against this one compiles against the real one (packages/client).
const clientOf = (
  recorded: Recorded,
  answers: {
    readonly list?: ReadonlyArray<ThreadSummary>
    readonly actors?: ReadonlyArray<ActorSummary>
    readonly events?: ReadonlyArray<EventRow>
    readonly methods?: ReadonlyArray<MethodSummary>
    readonly models?: ModelCatalogPage
    readonly providers?: ProviderCatalogPage
    readonly states?: ReadonlyArray<MethodState>
    readonly fail?: ProblemError
  }
): Client => {
  let read = 0
  return {
    baseUrl: "http://localhost:0",
    actor: RESERVED_ACTOR,
    identity: () => Promise.resolve({ name: RESERVED_ACTOR, sqlite: "/work/.tardigrade/actor.sqlite" }),
    actors: () => answers.fail === undefined
      ? Promise.resolve(answers.actors ?? [{ name: RESERVED_ACTOR, builtIn: true }])
      : Promise.reject(answers.fail),
    providers: (options) => {
      recorded.catalog.push({ kind: "providers", options })
      return Promise.resolve(answers.providers ?? {
        revision: "catalog-1",
        status: "fresh",
        refreshed_at: 1,
        total: 0,
        limit: 50,
        items: []
      })
    },
    models: (options) => {
      recorded.catalog.push({ kind: "models", options })
      return Promise.resolve(answers.models ?? {
        revision: "catalog-1",
        status: "fresh",
        refreshed_at: 1,
        total: 0,
        limit: 50,
        items: []
      })
    },
    list: () => (answers.fail === undefined ? Promise.resolve(answers.list ?? []) : Promise.reject(answers.fail)),
    methods: () => answers.fail === undefined ? Promise.resolve(answers.methods ?? []) : Promise.reject(answers.fail),
    events: (thread, options) => {
      recorded.asked.push({ thread, options })
      return answers.fail === undefined ? Promise.resolve(answers.events ?? []) : Promise.reject(answers.fail)
    },
    methodState: () => {
      recorded.methodReads += 1
      const states = answers.states ?? []
      const state = states[Math.min(read++, states.length - 1)]
      return state === undefined ? refuse() : Promise.resolve(state)
    },
    invoke: (thread, name, invocation) => {
      recorded.invoked.push({
        thread,
        method: name,
        id: invocation.id,
        input: invocation.input
      })
      return answers.fail === undefined
        ? Promise.resolve({
          actor: RESERVED_ACTOR,
          thread,
          method: name,
          call: invocation.id
        } satisfies MethodAccepted)
        : Promise.reject(answers.fail)
    },
    append: refuse,
    projection: refuse as Client["projection"],
    tree: refuse,
    resume: refuse,
    health: refuse,
    follow: () => () => {}
  }
}

interface Ran {
  readonly lines: ReadonlyArray<string>
  readonly failure: CliError.CliError | undefined
  readonly failed: boolean
  readonly recorded: Recorded
}

// drive runs one invocation and answers with what it printed and whether it failed. `renderErrors`
// is off so a case reads the failure rather than the terminal, which is the same value the runner
// renders (Command.run).
const drive = async (
  args: ReadonlyArray<string>,
  options: {
    readonly answers?: Parameters<typeof clientOf>[1]
    readonly env?: Record<string, string | undefined>
    readonly ids?: ReadonlyArray<string>
    readonly cwd?: string
    readonly installProject?: (directory: string) => Promise<void>
  } = {}
): Promise<Ran> => {
  const lines: Array<string> = []
  const recorded: Recorded = { invoked: [], asked: [], catalog: [], installed: [], methodReads: 0 }
  const minted = [...(options.ids ?? ["minted-1", "minted-2", "minted-3"])]
  const services: CliServices = {
    env: options.env ?? {},
    cwd: options.cwd ?? process.cwd(),
    openClient: () => clientOf(recorded, options.answers ?? {}),
    installProject: (directory) => {
      recorded.installed.push(directory)
      return options.installProject?.(directory) ?? Promise.resolve()
    },
    mintId: () => minted.shift() ?? "exhausted"
  }
  const capture: Console.Console = Object.assign(Object.create(console), {
    log: (...parts: ReadonlyArray<unknown>) => {
      lines.push(parts.map((part) => String(part)).join(" "))
    },
    error: () => {}
  })
  const exit = await Command.runWith(tdg, { version: "test", renderErrors: false })([...args]).pipe(
    Effect.provideService(Console.Console, capture),
    Effect.provide(Layer.mergeAll(BunServices.layer, Layer.succeed(Cli)(services))),
    Effect.runPromiseExit
  )
  return {
    lines,
    failed: Exit.isFailure(exit),
    failure: Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined,
    recorded
  }
}

// What the runner would render. A parse refusal arrives as ShowHelp carrying the refusals it would
// print under the help, so the message a case asserts on is the one a person reads (CliError).
const failureText = (ran: Ran): string =>
  ran.failure === undefined
    ? ""
    : ran.failure._tag === "ShowHelp"
    ? ran.failure.errors.map((nested) => nested.message).join("\n")
    : ran.failure.message

describe("parsing", () => {
  test("the root with no subcommand prints its help", async () => {
    const ran = await drive([])
    expect(ran.lines.join("\n")).toContain("tdg")
    expect(ran.lines.join("\n")).toContain("dev")
    expect(ran.lines.join("\n")).toContain("events")
  })

  // tdg help groups the same command declarations that the parser accepts, without changing their paths.
  test("the tree groups commands, and setup says what it writes", async () => {
    const root = (await drive([])).lines.join("\n")
    for (const group of ["CREATE:", "RUN:", "CATALOG:", "INSPECT:"]) {
      expect(root).toContain(group)
    }
    for (const command of ["setup", "init", "build", "providers", "models", "methods", "call"]) {
      expect(root).toContain(command)
    }
    expect(root).not.toContain("push")
    expect(root.indexOf("init")).toBeLessThan(root.indexOf("setup"))
    expect(root).not.toContain("run ")
    expect(root).not.toContain("send")
    const help = (await drive(["setup", "--help"])).lines.join("\n")
    expect(help).toContain("platform manifests")
    expect(help).toContain(".dev.vars")
    expect(help).toContain("0600")
    expect(help).toContain("provider")
    expect(help).toContain("default")
    const providerHelp = (await drive(["setup", "provider", "--help"])).lines.join("\n")
    expect(providerHelp).toContain("<provider>")
    expect(providerHelp).toContain("<config>")
    expect(providerHelp).not.toContain("--base-url")
    const defaultHelp = (await drive(["setup", "default", "--help"])).lines.join("\n")
    expect(defaultHelp).toContain("--provider")
    expect(defaultHelp).toContain("--model")
  })

  test("setup gives agents a declarative path instead of prompting", async () => {
    const ran = await drive(["setup"])
    expect(ran.failed).toBe(true)
    expect(failureText(ran)).toContain("setup provider")
    expect(failureText(ran)).toContain("setup default")
  })

  test("setup provider and default are independent declarative operations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tdg-setup-command-"))
    try {
      const provider = await drive([
        "setup",
        "provider",
        "openrouter",
        '{"env":["OPENROUTER_API_KEY"]}'
      ], { cwd })
      expect(provider.failed).toBe(false)
      expect(await readFile(join(cwd, "wrangler.jsonc"), "utf8")).not.toContain('"default"')
      await expect(readFile(join(cwd, ".dev.vars"), "utf8")).rejects.toThrow()

      const selected = await drive([
        "setup",
        "default",
        "--provider",
        "openrouter",
        "--model",
        "anthropic/claude-sonnet-4-6"
      ], { cwd })
      expect(selected.failed).toBe(false)
      const config = await readFile(join(cwd, "wrangler.jsonc"), "utf8")
      expect(config).toContain('"provider": "openrouter"')
      expect(config).toContain('"model_id": "anthropic/claude-sonnet-4-6"')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("init gives agents a declarative path instead of prompting", async () => {
    const ran = await drive(["init", "researcher"])
    expect(ran.failed).toBe(true)
    expect(failureText(ran)).toContain("--provider-config")
  })

  test("init requires a name when nobody can answer", async () => {
    const ran = await drive(["init"])
    expect(ran.failed).toBe(true)
    expect(failureText(ran)).toContain("<name>")
  })

  test("agent init writes one matching actor and connection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tdg-init-command-"))
    try {
      const ran = await drive([
        "init",
        "researcher",
        "--provider",
        "openrouter",
        "--provider-config",
        '{"env":["OPENROUTER_API_KEY"]}',
        "--default-model",
        "anthropic/claude-sonnet-4-6",
        "--json"
      ], { cwd })
      const directory = join(cwd, "researcher")
      const actor = await readFile(join(directory, "actor.ts"), "utf8")
      const config = await readFile(join(directory, "wrangler.jsonc"), "utf8")

      expect(ran.failed).toBe(false)
      expect(actor).toContain('provider: "openrouter", default_model: "anthropic/claude-sonnet-4-6"')
      expect(config).toContain('"provider": "openrouter"')
      expect(config).toContain('"model_id": "anthropic/claude-sonnet-4-6"')
      expect(ran.recorded.installed).toEqual([directory])
      await expect(readFile(join(directory, ".dev.vars"), "utf8")).rejects.toThrow()
      expect(ran.lines.join("\n")).toContain('"credential": "environment"')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("a command's help names its flags", async () => {
    const ran = await drive(["events", "--help"])
    const help = ran.lines.join("\n")
    expect(help).toContain("--after")
    expect(help).toContain("--limit")
    expect(help).toContain("--types")
    expect(help).toContain("--json")
    expect(help).toContain("--actor")
    const devHelp = (await drive(["dev", "--no-open", "--help"])).lines.join("\n")
    expect(devHelp).toContain("--open")
    expect(devHelp).toContain("--no-open")
    expect(devHelp).toContain("--min-port")
    expect(devHelp).toContain("--max-concurrent-lanes")
    const initHelp = (await drive(["init", "--help"])).lines.join("\n")
    expect(initHelp).toContain("--dir")
    for (const flag of ["--provider", "--provider-config", "--default-model"]) {
      expect(initHelp).toContain(flag)
    }
    expect(initHelp).not.toContain("--base-url")
  })

  test("init leaves an existing target unchanged", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tdg-init-existing-"))
    const directory = join(cwd, "researcher")
    const held = join(directory, "wrangler.jsonc")
    try {
      await mkdir(directory)
      await writeFile(held, "keep me\n")
      const ran = await drive([
        "init",
        "researcher",
        "--provider",
        "openrouter",
        "--provider-config",
        '{"env":["OPENROUTER_API_KEY"]}',
        "--default-model",
        "anthropic/claude-sonnet-4.6"
      ], { cwd })

      expect(ran.failed).toBe(true)
      expect(failureText(ran)).toContain("target already exists")
      expect(await readFile(held, "utf8")).toBe("keep me\n")
      expect(ran.recorded.installed).toEqual([])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("init removes its fresh directory when installation fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tdg-init-failure-"))
    const directory = join(cwd, "researcher")
    try {
      const ran = await drive([
        "init",
        "researcher",
        "--provider",
        "openrouter",
        "--provider-config",
        '{"env":["OPENROUTER_API_KEY"]}',
        "--default-model",
        "anthropic/claude-sonnet-4.6"
      ], {
        cwd,
        installProject: () => Promise.reject(new Error("bun install exited 1"))
      })

      expect(ran.failed).toBe(true)
      expect(failureText(ran)).toContain("bun install exited 1")
      expect(failureText(ran)).toContain("removed incomplete project")
      await expect(readFile(join(directory, "actor.ts"), "utf8")).rejects.toThrow()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("an unknown command fails", async () => {
    const ran = await drive(["fly"])
    expect(ran.failed).toBe(true)
  })

  test("removed registry commands fail", async () => {
    expect((await drive(["push"])).failed).toBe(true)
    expect((await drive(["actors"])).failed).toBe(true)
  })

  test("a missing argument fails", async () => {
    const ran = await drive(["events"])
    expect(ran.failed).toBe(true)
    expect(failureText(ran).toLowerCase()).toContain("thread")
  })

  test("an unknown flag fails", async () => {
    const ran = await drive(["ls", "--loud"])
    expect(ran.failed).toBe(true)
    expect(failureText(ran)).toContain("loud")
  })

  test("a flag that wants a number refuses a word", async () => {
    const ran = await drive(["events", "root", "--after", "soon"])
    expect(ran.failed).toBe(true)
  })
})

describe("ls", () => {
  test("the human rendering is a table", async () => {
    const ran = await drive(["ls"], { answers: { list: threads } })
    expect(ran.failed).toBe(false)
    const lines = (ran.lines[0] ?? "").split("\n")
    expect(lines[0]).toContain("THREAD")
    expect(lines[1]).toContain("root")
  })

  test("--json prints the client's value verbatim", async () => {
    const ran = await drive(["ls", "--json"], { answers: { list: threads } })
    expect(JSON.parse(ran.lines[0] ?? "")).toEqual(threads)
  })
})

describe("catalog discovery", () => {
  test("providers forwards search and pagination and prints requirements", async () => {
    const ran = await drive(["providers", "--search", "open", "--limit", "1", "--cursor", "next"], {
      answers: {
        providers: {
          revision: "catalog-2",
          status: "cached",
          refreshed_at: 2,
          total: 2,
          limit: 1,
          next_cursor: "last",
          items: [{
            id: "openrouter",
            name: "OpenRouter",
            protocol: "openai-chat-completions",
            baseUrl: "https://openrouter.ai/api/v1",
            env: ["OPENROUTER_API_KEY"],
            required: ["env"],
            optional: ["baseUrl"]
          }]
        }
      }
    })
    expect(ran.failed).toBe(false)
    expect(ran.recorded.catalog).toEqual([{
      kind: "providers",
      options: { cursor: "next", limit: 1, search: "open" }
    }])
    expect(ran.lines.join("\n")).toContain("openrouter")
    expect(ran.lines.join("\n")).toContain("next cursor last")
  })

  test("models forwards its provider filter and prints the page as JSON", async () => {
    const ran = await drive(["models", "--provider", "openrouter", "--search", "claude", "--json"])
    expect(ran.failed).toBe(false)
    expect(ran.recorded.catalog).toEqual([{
      kind: "models",
      options: { cursor: undefined, limit: undefined, provider: "openrouter", search: "claude" }
    }])
    expect(JSON.parse(ran.lines[0]!)).toMatchObject({ revision: "catalog-1", items: [] })
  })
})

describe("events", () => {
  test("the human rendering is one line per event", async () => {
    const ran = await drive(["events", "root"], { answers: { events } })
    const lines = (ran.lines[0] ?? "").split("\n")
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain("MessageReceived")
  })

  test("--json prints the rows verbatim", async () => {
    const ran = await drive(["events", "root", "--json"], { answers: { events } })
    expect(JSON.parse(ran.lines[0] ?? "")).toEqual(events)
  })

  test("the paging flags reach the client", async () => {
    const ran = await drive(
      ["events", "root", "--after", "3", "--limit", "5", "--types", "MessageReceived, TurnCompleted"],
      { answers: { events } }
    )
    expect(ran.recorded.asked[0]).toEqual({
      thread: "root",
      options: { after: 3, limit: 5, types: ["MessageReceived", "TurnCompleted"] }
    })
  })
})

describe("methods", () => {
  const methods: ReadonlyArray<MethodSummary> = [{
    name: "message",
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    outputSchema: { type: "string" }
  }]

  test("the human rendering shows each method and schema", async () => {
    const ran = await drive(["methods"], { answers: { methods } })
    expect(ran.failed).toBe(false)
    expect(ran.lines[0]).toContain("message")
    expect(ran.lines[0]).toContain("\"required\":[\"text\"]")
    expect(ran.lines[0]).toContain("output {\"type\":\"string\"}")
  })

  test("--json prints the method catalog verbatim", async () => {
    const ran = await drive(["methods", "--json"], { answers: { methods } })
    expect(JSON.parse(ran.lines[0] ?? "")).toEqual(methods)
  })
})

describe("call", () => {
  test("a pending call is polled until it settles, and the output is printed", async () => {
    const ran = await drive(
      ["call", "message", "{\"text\":\"summarize\"}", "--thread", "root", "--id", "m1", "--poll", "1"],
      {
        answers: {
          states: [
            { status: "pending" },
            { status: "completed", output: "the summary" }
          ]
        }
      }
    )
    expect(ran.failed).toBe(false)
    expect(ran.lines[0]).toBe(
      "root m1 completed\nthe summary\n\ntrace\n  http://localhost:0/?thread=root"
    )
    expect(ran.recorded.invoked).toEqual([{
      thread: "root",
      method: "message",
      id: "m1",
      input: { text: "summarize" }
    }])
  })

  test("a custom method receives its JSON input", async () => {
    const ran = await drive(["call", "inspect", "{\"path\":\"README.md\",\"depth\":2}", "--poll", "1"], {
      answers: { states: [{ status: "completed", output: { findings: 3 } }] }
    })
    expect(ran.recorded.invoked).toEqual([{
      thread: "minted-1",
      method: "inspect",
      id: "minted-2",
      input: { path: "README.md", depth: 2 }
    }])
    expect(ran.lines[0]).toContain('{\n  "findings": 3\n}')
  })

  test("--no-wait prints the durable handle without reading state", async () => {
    const ran = await drive(["call", "message", "{\"text\":\"again\"}", "--thread", "root", "--id", "m1", "--no-wait"])
    expect(ran.failed).toBe(false)
    expect(ran.lines[0]).toBe("root m1 accepted")
    expect(ran.recorded.methodReads).toBe(0)
  })

  test("--json includes the handle and terminal state", async () => {
    const ran = await drive(["call", "message", "{\"text\":\"again\"}", "--thread", "root", "--id", "m1", "--json"], {
      answers: { states: [{ status: "completed", output: "done" }] }
    })
    expect(JSON.parse(ran.lines[0] ?? "")).toEqual({
      actor: RESERVED_ACTOR,
      thread: "root",
      method: "message",
      call: "m1",
      status: "completed",
      output: "done"
    })
  })

  test("malformed JSON is refused before a method is invoked", async () => {
    const ran = await drive(["call", "message", "hello"])
    expect(ran.failed).toBe(true)
    expect(failureText(ran)).toContain("valid JSON")
    expect(ran.recorded.invoked).toEqual([])
  })

  test("a failed call prints its error and exits non-zero", async () => {
    const ran = await drive(["call", "message", "{\"text\":\"hello\"}", "--thread", "root", "--id", "m1", "--poll", "1"], {
      answers: { states: [{ status: "failed", error: "no model is configured" }] }
    })
    expect(ran.lines[0]).toBe("root m1 failed\nno model is configured")
    expect(ran.failed).toBe(true)
  })

  test("a blocked call prints its reason and exits non-zero", async () => {
    const ran = await drive(["call", "message", "{\"text\":\"hello\"}", "--thread", "root", "--id", "m1", "--poll", "1"], {
      answers: { states: [{ status: "blocked", reason: "budget" }] }
    })
    expect(ran.lines[0]).toBe("root m1 blocked\nbudget")
    expect(ran.failed).toBe(true)
  })

  test("a call that never settles gives up rather than hanging", async () => {
    const ran = await drive(["call", "message", "{\"text\":\"hello\"}", "--thread", "root", "--id", "m1", "--poll", "1", "--timeout", "0"], {
      answers: { states: [{ status: "pending" }] }
    })
    expect(ran.failed).toBe(true)
    expect(failureText(ran)).toContain("still pending")
  })
})

describe("failures", () => {
  const problem = new ProblemError({
    type: "https://tardigrade.dev/problems/unknown-thread",
    title: "Unknown Thread",
    status: 404,
    detail: "No thread named \"ghost\" has ever existed."
  })

  test("a problem document prints its title, status, and detail", () => {
    expect(problemLine(problem)).toBe("Unknown Thread (404): No thread named \"ghost\" has ever existed.")
  })

  // A call that never reached a response has no status line to quote.
  test("an unreachable server prints its title alone", () => {
    expect(problemLine(new ProblemError({ title: "Server Unreachable", status: 0 }))).toBe("Server Unreachable")
  })

  test("a failed call exits non-zero carrying the server's words", async () => {
    const ran = await drive(["events", "ghost"], { answers: { fail: problem } })
    expect(ran.failed).toBe(true)
    expect(failureText(ran)).toContain("Unknown Thread (404)")
  })
})

describe("dev asks only where someone can answer", () => {
  // A boot inside CI, a container, or a script has nobody to answer a prompt, so it takes the
  // notice and serves anyway. The terminal check is what separates the two (commands.ts, canAsk).
  test("says what is missing when stdin is not a terminal", () => {
    expect(process.stdin.isTTY).not.toBe(true)
    expect(NO_MODEL_NOTICE).toContain("tdg setup")
    expect(NO_MODEL_NOTICE).toContain("tdg setup")
  })
})
