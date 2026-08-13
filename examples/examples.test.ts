import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

// The examples are teaching artifacts, so they have to keep working. This suite runs each one as
// a real process and reads its output, which is what makes a refactor that breaks an example fail
// the gate rather than a reader's afternoon.

const examples = fileURLToPath(new URL("./", import.meta.url))

const run = async (script: string, ...args: ReadonlyArray<string>) => {
  const proc = Bun.spawn(["bun", "run", script, ...args], {
    cwd: examples,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AI_GATEWAY_API_KEY: "" }
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ])
  const code = await proc.exited
  return { code, output: `${out}${err}` }
}

// The event types docs/building-an-agent.md promises for a turn that calls one tool and answers.
const DOCUMENTED_LOG = [
  "MessageReceived",
  "ModelCalled",
  "ModelReturned",
  "TextReturned",
  "ToolCalled",
  "ToolReturned",
  "ModelCalled",
  "ModelReturned",
  "TurnCompleted",
  "ReplyDelivered"
]

const typesIn = (output: string): ReadonlyArray<string> =>
  output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\s+[A-Z]/.test(line))
    .map((line) => line.split(/\s+/)[1] ?? "")

describe("support-agent", () => {
  test("answers offline and produces the documented log", async () => {
    const { code, output } = await run("support-agent/main.ts")

    expect(code).toBe(0)
    expect(output).toContain("stub (offline, no key needed)")
    expect(output).toContain("Invoice INV-4182 totals 312.00 and is paid.")
    expect(typesIn(output)).toEqual(DOCUMENTED_LOG)
    expect(output).toContain("log (10 events)")
  }, 30_000)

  test("every event the run emitted is declared by a module", async () => {
    const { code, output } = await run("support-agent/main.ts")

    expect(code).toBe(0)
    // `Module.events` is a contract, not a comment: the alphabet the modules declared covers the
    // whole run. A module that emitted an undeclared type would name it on this line.
    expect(output).toContain(
      "declared alphabet: 16 event types, and the run emitted nothing outside it"
    )
  }, 30_000)

  test("reads the question from the command line", async () => {
    const { code, output } = await run("support-agent/main.ts", "What about order 4201?")

    expect(code).toBe(0)
    expect(output).toContain("Invoice INV-4201 totals 45.25 and is refunded.")
  }, 30_000)

  test("two runs of one question agree exactly", async () => {
    const first = await run("support-agent/main.ts")
    const second = await run("support-agent/main.ts")

    expect(first.code).toBe(0)
    expect(second.code).toBe(0)
    // The harness is content addressed and the stub is a function of the request, so two runs of
    // one question agree on the answer, the spend, and the whole event list.
    expect(second.output).toEqual(first.output)
  }, 30_000)
})

describe("replay", () => {
  test("reproduces the recorded run with no model call and nothing appended", async () => {
    const { code, output } = await run("replay/main.ts")

    expect(code).toBe(0)
    expect(output).toContain("PROVED")
    expect(output).toContain("events appended by the replay:  0")
    expect(output).toContain("logs are identical:             yes")
    expect(output).toContain("the recording after the replay: 10 events (was 10)")
    // The model that throws was never reached: the replay column reports zero calls.
    expect(output).toMatch(/model calls\s+2\s+0/)
  }, 30_000)
})
