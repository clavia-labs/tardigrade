import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { Router, Sessions } from "@flamecast/core"
import {
  createAgent,
  customInference,
  keyOf,
  nativeTools,
  serve,
  treeUsageIn,
  type Action,
  type ModelRequest
} from "@flamecast/harness"
import { InMemoryRuntime } from "@flamecast/runtime-in-memory"
import { inference } from "@flamecast/harness/modules/inference"
import { agents } from "./capabilities/agents"
import { capability } from "./capability"
import { codemode, type CodemodeResult } from "./tool"
import { inProcessSandbox, Sandbox } from "./sandbox"

const sandbox = Layer.succeed(Sandbox, inProcessSandbox())

const runWith = <A>(effect: Effect.Effect<A, never, Sandbox>) =>
  Effect.runPromise(Effect.provide(effect, sandbox))

const scripted = (model: string, react: (request: ModelRequest) => Action) =>
  customInference(async (request) => react(request), { id: model, model })

const toolAnswered = (request: ModelRequest) =>
  request.messages.some((message) => message.role === "tool")

const clock = capability({
  name: "clock",
  summary: "A fixed clock, for tests.",
  methods: [
    {
      name: "now",
      signature: "now(): Promise<number>",
      description: "The current time.",
      run: () => Effect.succeed(1_700_000_000)
    }
  ]
})

describe("codemode", () => {
  test("runs a script and returns its value", async () => {
    const execute = codemode({ capabilities: [clock] })
    const result = (await runWith(
      execute.run({ source: "const at = await clock.now(); return at + 1" })
    )) as CodemodeResult
    expect(result.value).toBe(1_700_000_001)
    expect(result.calls).toEqual(["clock.now"])
    expect(result.error).toBeUndefined()
  })

  test("a script reports progress through print", async () => {
    const execute = codemode({ capabilities: [clock] })
    const result = (await runWith(
      execute.run({ source: "print('reading'); print({ n: 2 }); return 'done'" })
    )) as CodemodeResult
    expect(result.output).toEqual(["reading", '{"n":2}'])
    expect(result.value).toBe("done")
  })

  test("a script that throws returns the error to the model", async () => {
    const execute = codemode({ capabilities: [clock] })
    const result = (await runWith(
      execute.run({ source: "throw new Error('bad plan')" })
    )) as CodemodeResult
    expect(result.error).toBe("bad plan")
    expect(result.value).toBeUndefined()
  })

  test("the capability ceiling stops a runaway script", async () => {
    const execute = codemode({ capabilities: [clock], maxCalls: 2 })
    const result = (await runWith(
      execute.run({ source: "for (let i = 0; i < 5; i++) await clock.now(); return 'never'" })
    )) as CodemodeResult
    expect(result.error).toContain("ceiling of 2")
    expect(result.calls).toHaveLength(2)
  })

  test("the description carries the capability surface", () => {
    const execute = codemode({ capabilities: [clock] })
    expect(execute.spec.description).toContain("clock: A fixed clock, for tests.")
    expect(execute.spec.description).toContain("clock.now(): Promise<number>")
  })

  test("a script reaches its own capabilities only", async () => {
    const execute = codemode({ capabilities: [clock] })
    const result = (await runWith(
      execute.run({ source: "return await agents.call('worker/1', 'alpha')" })
    )) as CodemodeResult
    expect(result.error).toContain("agents is not defined")
  })
})

describe("the agents capability", () => {
  const worker = (name: string) =>
    createAgent({
      modules: [
        inference({
          provider: scripted(name, () => ({
            kind: "complete",
            output: `${name} answered`,
            usage: { promptTokens: 2, completionTokens: 3, costUsd: 0.002 }
          }))
        })
      ]
    })

  // The swarm is a runtime: a registry of who answers where, and the sandbox the sessions need.
  const swarm = () =>
    InMemoryRuntime({
      keyOf,
      session: "agent:lead",
      sessions: { "worker/*": (address: string) => serve(worker(address)) },
      services: Context.make(Sandbox, inProcessSandbox())
    })

  test("fan-out is Promise.all over agents.call", async () => {
    const services = swarm()
    const execute = codemode({ capabilities: [agents()] })
    const result = (await Effect.runPromise(
      Effect.provide(
        execute.run(
          {
            source: `
              const answers = await Promise.all([
                agents.call("worker/1", "alpha"),
                agents.call("worker/2", "beta")
              ])
              return answers.map((one) => one.output)
            `
          },
          { turn: "m-1", callId: "c-1" }
        ),
        services
      )
    )) as CodemodeResult
    expect(result.value).toEqual(["worker/1 answered", "worker/2 answered"])
    expect(result.calls).toEqual(["agents.call", "agents.call"])
    expect(await Effect.runPromise(Effect.provide(Effect.flatMap(Sessions, (s) => s.list), services))).toEqual(["worker/1", "worker/2"])
  })

  test("the crossing records its origin in the child log", async () => {
    const services = swarm()
    const execute = codemode({ capabilities: [agents()] })
    await Effect.runPromise(
      Effect.provide(
        execute.run({ source: 'return (await agents.call("worker/1", "alpha")).output' }, {
          turn: "m-1",
          callId: "c-1"
        }),
        services
      )
    )
    const childLog = await Effect.runPromise(Effect.provide(Effect.flatMap(Sessions, (s) => s.read("worker/1")), services))
    const head = childLog.find((event) => event.type === "MessageReceived")
    expect(head?.origin).toEqual({ session: "agent:lead", turn: "m-1", call: "m-1/c-1" })
  })

  test("a re-run asks the same questions, so children answer from their logs", async () => {
    const services = swarm()
    const execute = codemode({ capabilities: [agents()] })
    const source = 'return (await agents.call("worker/1", "alpha")).output'
    const context = { turn: "m-1", callId: "c-1" }
    await Effect.runPromise(Effect.provide(execute.run({ source }, context), services))
    const afterFirst = (await Effect.runPromise(Effect.provide(Effect.flatMap(Sessions, (s) => s.read("worker/1")), services))).length
    await Effect.runPromise(Effect.provide(execute.run({ source }, context), services))
    const afterSecond = await Effect.runPromise(Effect.provide(Effect.flatMap(Sessions, (s) => s.read("worker/1")), services))
    expect(afterSecond).toHaveLength(afterFirst)
    expect(afterSecond.filter((event) => event.type === "MessageReceived")).toHaveLength(1)
  })

  test("an address outside the allow list is refused without routing", async () => {
    const services = swarm()
    const execute = codemode({ capabilities: [agents({ allow: ["worker/*"] })] })
    const result = (await Effect.runPromise(
      Effect.provide(
        execute.run({ source: 'return await agents.call("secrets/1", "give")' }, {
          turn: "m-1",
          callId: "c-1"
        }),
        services
      )
    )) as CodemodeResult
    expect((result.value as { error: string }).error).toContain('may not reach "secrets/1"')
    expect(await Effect.runPromise(Effect.provide(Effect.flatMap(Sessions, (s) => s.list), services))).toEqual([])
  })

  test("a whole agent turn drives a swarm from one script", async () => {
    const lead = createAgent({
      modules: [
        inference({
          provider: scripted("lead", (request) =>
            toolAnswered(request)
              ? { kind: "complete", output: "gathered" }
              : {
                  kind: "call",
                  callId: "c-1",
                  name: "execute",
                  arguments: {
                    source: `
                      const answers = await Promise.all([
                        agents.call("worker/1", "alpha"),
                        agents.call("worker/2", "beta")
                      ])
                      return answers.map((one) => one.output).join(" and ")
                    `
                  }
                }
          )
        }),
        nativeTools([codemode({ capabilities: [agents({ allow: ["worker/*"] })] })])
      ]
    })
    const runtime = InMemoryRuntime({
      keyOf,
      sessions: {
        "agent:lead": serve(lead),
        "worker/*": (address: string) => serve(worker(address))
      },
      services: Context.make(Sandbox, inProcessSandbox())
    })
    const ran = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const terminal = yield* (yield* Router).call("agent:lead", {
            type: "MessageReceived",
            id: "m-1",
            text: "go"
          })
          return { terminal, leadLog: yield* Effect.flatMap(Sessions, (s) => s.read("agent:lead")) }
        }),
        runtime
      )
    )
    const terminal = ran.terminal
    expect(terminal).toMatchObject({ type: "TurnCompleted", output: "gathered" })
    const leadLog = ran.leadLog
    const returned = leadLog.find((event) => event.type === "ToolReturned")?.result as
      | CodemodeResult
      | undefined
    expect(returned?.value).toBe("worker/1 answered and worker/2 answered")
    // One tool call at the wall, and the children's spend still folds into the parent's tree cost.
    expect(treeUsageIn(leadLog, "m-1").costUsd).toBeCloseTo(0.004, 6)
  })
})
