import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import type { Event } from "@tardigrade/core/event"
import { EventLog, withWatermark } from "@tardigrade/core/event-log"
import { Router } from "@tardigrade/core/router"
import { Self } from "@tardigrade/core/actor"
import { agentOf, budget, codeMode, compaction, compactionFor, renderOf, reply, toolList } from "./capability"
import { receive } from "./turn"
import { Infer, type InferRequest } from "./infer"

// The capability assembly end to end: the render the model sees is the composed derivation of
// the mounted capabilities, and a call routes to the capability that declared its tool.

const memoryLog = (initial: ReadonlyArray<Event> = []) =>
  Layer.effect(
    EventLog,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyArray<Event>>(initial)
      return withWatermark({
        append: (events: ReadonlyArray<Event>) => Ref.update(ref, (log) => [...log, ...events]),
        read: Ref.get(ref)
      })
    })
  )

const noRouter = Layer.mergeAll(
  Layer.succeed(Router, {
    deliver: () => Effect.void,
    call: () => Effect.succeed({ error: "no router bound" }),
    resume: () => Effect.succeed({ error: "no router bound" })
  }),
  Layer.succeed(Self, "test-agent")
)

const readLog = Effect.flatMap(EventLog, (log) => log.read)
const run = <A, R>(effect: Effect.Effect<A, never, R>, layers: Layer.Layer<R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layers)) as Effect.Effect<A>)

const echoTable = toolList([
  {
    spec: { name: "echo", description: "echoes", inputSchema: { type: "object" } },
    run: (input) => Effect.succeed({ echoed: input })
  }
])

describe("agentOf", () => {
  test("the render is the composed derivation, and the request carries it to the model", async () => {
    const seen: InferRequest[] = []
    const mind = Layer.succeed(Infer, {
      react: (request: InferRequest) => {
        seen.push(request)
        const returned = request.trajectory.some((e) => e.type === "ToolReturned")
        return Effect.succeed(
          returned
            ? { kind: "complete" as const, output: "done" }
            : { kind: "call" as const, callId: "c1", name: "echo", arguments: { hi: 1 } }
        )
      }
    })
    const agent = agentOf([echoTable, reply, budget, compaction])
    const events = await run(
      Effect.gen(function* () {
        yield* receive(agent, { id: "m1", text: "go" })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog(), mind, noRouter)
    )
    // The model was shown exactly what the capabilities derived.
    expect(seen[0]!.tools.map((t) => t.name)).toEqual(["echo"])
    expect(seen[0]!.system).toContain("echo")
    // The call routed to the table capability and settled.
    expect(events.find((e) => e.type === "ToolReturned")).toMatchObject({ callId: "c1", result: { echoed: { hi: 1 } } })
    expect(events.at(-2)?.type).toBe("TurnCompleted")
  })

  test("a call no capability recognizes answers unknown-tool naming the composed tools", async () => {
    const mind = Layer.succeed(Infer, {
      react: (request: InferRequest) => {
        const returned = request.trajectory.find((e) => e.type === "ToolReturned") as { result?: unknown } | undefined
        return Effect.succeed(
          returned === undefined
            ? { kind: "call" as const, callId: "c9", name: "ghost", arguments: {} }
            : { kind: "complete" as const, output: JSON.stringify(returned.result) }
        )
      }
    })
    const agent = agentOf([echoTable, reply])
    const events = await run(
      Effect.gen(function* () {
        yield* receive(agent, { id: "m1", text: "go" })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog(), mind, noRouter)
    )
    expect(events.find((e) => e.type === "ToolReturned")).toMatchObject({
      result: { error: "unknown tool: ghost. Call one of: echo." }
    })
  })

  test("two capabilities declaring one tool name collide at construction", () => {
    expect(() => agentOf([echoTable, toolList([{ spec: { name: "echo", description: "again", inputSchema: {} }, run: () => Effect.succeed({}) }])])).toThrow(
      'tool "echo" declared by capabilities tools and tools'
    )
  })

  test("compactionFor's context reaches the render, so the guard and the request hold one policy", () => {
    const render = renderOf([codeMode, compactionFor({ messageRenderCap: 1234 })], [])
    expect(render.context).toEqual({ messageRenderCap: 1234 })
  })

  test("renderOf composes system fragments and tools in mount order", () => {
    const render = renderOf([codeMode, echoTable], [])
    expect(render.tools.map((t) => t.name)).toEqual(["execute", "echo"])
    expect(render.system.indexOf("execute")).toBeLessThan(render.system.indexOf("echo"))
  })
})
