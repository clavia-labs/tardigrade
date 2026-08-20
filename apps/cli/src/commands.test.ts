import { describe, expect, test } from "bun:test"
import { Cause, Console, Effect, Exit, Layer, Option } from "effect"
import { CliError, Command } from "effect/unstable/cli"
import { BunServices } from "@effect/platform-bun"
import { ProblemError, RESERVED_ACTOR, type Accepted, type ThreadSummary, type Client, type EventRow, type TurnView } from "@clavia/tardigrade-client"

import { problemLine, tdg } from "./commands"
import { Cli, type CliServices } from "./services"

// The command tree, driven the way a shell drives it: real arguments through the real parser, over
// a client this file wrote. Nothing here spawns a process, and nothing here reaches a network.

const threads: ReadonlyArray<ThreadSummary> = [
  { id: "root", events: 2, lastAt: 0, status: "settled" }
]

const events: ReadonlyArray<EventRow> = [
  { seq: 1, event: { type: "MessageReceived", text: "hello" } },
  { seq: 2, event: { type: "TurnCompleted", output: "ok" } }
]

interface Recorded {
  readonly delivered: Array<{ thread: string; id: string; text: string }>
  readonly asked: Array<{ thread: string; options: unknown }>
}

const refuse = () => Promise.reject(new Error("this command should not have called that"))

// A client whose answers are stated per case. Its methods are the derived client's own, so a
// handler that compiles against this one compiles against the real one (packages/client).
const clientOf = (
  recorded: Recorded,
  answers: {
    readonly list?: ReadonlyArray<ThreadSummary>
    readonly events?: ReadonlyArray<EventRow>
    readonly turns?: ReadonlyArray<TurnView>
    readonly fail?: ProblemError
  }
): Client => {
  let read = 0
  return {
    baseUrl: "http://localhost:0",
    actor: RESERVED_ACTOR,
    list: () => (answers.fail === undefined ? Promise.resolve(answers.list ?? []) : Promise.reject(answers.fail)),
    events: (thread, options) => {
      recorded.asked.push({ thread, options })
      return answers.fail === undefined ? Promise.resolve(answers.events ?? []) : Promise.reject(answers.fail)
    },
    turn: (_thread, _turn) => {
      const views = answers.turns ?? []
      const view = views[Math.min(read++, views.length - 1)]
      return view === undefined ? refuse() : Promise.resolve(view)
    },
    deliver: (thread, message) => {
      recorded.delivered.push({ thread, id: message.id, text: message.text })
      return answers.fail === undefined
        ? Promise.resolve({ actor: RESERVED_ACTOR, thread, turn: message.id } satisfies Accepted)
        : Promise.reject(answers.fail)
    },
    tree: refuse,
    turns: refuse,
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
  } = {}
): Promise<Ran> => {
  const lines: Array<string> = []
  const recorded: Recorded = { delivered: [], asked: [] }
  const minted = [...(options.ids ?? ["minted-1", "minted-2", "minted-3"])]
  const services: CliServices = {
    env: options.env ?? {},
    openClient: () => clientOf(recorded, options.answers ?? {}),
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

  test("a command's help names its flags", async () => {
    const ran = await drive(["events", "--help"])
    const help = ran.lines.join("\n")
    expect(help).toContain("--after")
    expect(help).toContain("--limit")
    expect(help).toContain("--types")
    expect(help).toContain("--json")
  })

  test("an unknown command fails", async () => {
    const ran = await drive(["fly"])
    expect(ran.failed).toBe(true)
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

describe("send", () => {
  test("the turn handle is printed and nothing is waited on", async () => {
    const ran = await drive(["send", "root", "do the thing"])
    expect(ran.lines[0]).toBe("root minted-1")
    expect(ran.recorded.delivered).toEqual([{ thread: "root", id: "minted-1", text: "do the thing" }])
  })

  test("a stated id is the id, so a retry is absorbed", async () => {
    const ran = await drive(["send", "root", "again", "--id", "m1"])
    expect(ran.recorded.delivered[0]?.id).toBe("m1")
  })

  test("--json prints the handle verbatim", async () => {
    const ran = await drive(["send", "root", "again", "--json", "--id", "m1"])
    expect(JSON.parse(ran.lines[0] ?? "")).toEqual({ actor: RESERVED_ACTOR, thread: "root", turn: "m1" })
  })
})

describe("run", () => {
  test("a pending turn is polled until it settles, and the output is printed", async () => {
    const ran = await drive(
      ["run", "summarize", "--thread", "root", "--id", "m1", "--poll", "1"],
      {
        answers: {
          turns: [
            { turn: "m1", status: "pending" },
            { turn: "m1", status: "completed", output: "the summary" }
          ]
        }
      }
    )
    expect(ran.failed).toBe(false)
    expect(ran.lines[0]).toBe("root m1 completed\nthe summary")
  })

  test("a thread nobody named is minted, so a run births its own thread", async () => {
    const ran = await drive(["run", "hello", "--poll", "1"], {
      answers: { turns: [{ turn: "minted-2", status: "completed", output: "hi" }] }
    })
    expect(ran.recorded.delivered).toEqual([{ thread: "minted-1", id: "minted-2", text: "hello" }])
  })

  test("a failed turn prints its error and exits non-zero", async () => {
    const ran = await drive(["run", "hello", "--thread", "root", "--id", "m1", "--poll", "1"], {
      answers: { turns: [{ turn: "m1", status: "failed", error: "no model is configured" }] }
    })
    expect(ran.lines[0]).toBe("root m1 failed\nno model is configured")
    expect(ran.failed).toBe(true)
  })

  test("a turn that never settles gives up rather than hanging", async () => {
    const ran = await drive(["run", "hello", "--thread", "root", "--id", "m1", "--poll", "1", "--timeout", "0"], {
      answers: { turns: [{ turn: "m1", status: "pending" }] }
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
