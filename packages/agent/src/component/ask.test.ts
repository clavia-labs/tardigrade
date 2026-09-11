import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { actor, componentContractOf } from "@clavia/tardigrade-core/actor"
import { Self, enabled } from "@clavia/tardigrade-core/runtime"
import { Router } from "@clavia/tardigrade-core/transport/router"
import { ThreadAllocator } from "@clavia/tardigrade-core/actor/allocation"
import { parseThreadAddress, threadAddressOf } from "@clavia/tardigrade-core/transport/endpoint"
import { linkOf } from "@clavia/tardigrade-core/transport/link"
import { Infer } from "../runtime/turn"
import { NativeOutputSupport } from "../inference/contract"
import { infer, renderOf } from "../runtime/composition"
import { nativeOutput } from "./native-output"
import { tool } from "./tool"
import { agentMethods } from "../actor/methods"
import { agentKeys } from "../log/events"
import { ask, askCaller, ASK_TOOL_NAME } from "./ask"
import { requestAskMethod } from "../actor/ask"
import { boundaryOf, turnViewOf } from "../output/boundary"
import { createHost, type Host, type ThreadEnv } from "@clavia/tardigrade-host/host"
import { actorRuntimeOf } from "@clavia/tardigrade-core/runtime/actor"
import type { Action } from "../log/events"
import type { InferRequest } from "../inference/contract"
import type { AgentR } from "../runtime/turn"

const TEST_MODEL = { models: { default: { provider: "test", model_id: "test-model" }, allow: "*" } } as const

const APPROVAL = {
  type: "object",
  properties: { approved: { type: "boolean" } },
  required: ["approved"],
  additionalProperties: false
} as const

const assembled = <R>(component: import("../runtime/composition").AgentComponent<R>) => actor({
  name: "test-agent",
  methods: agentMethods,
  components: [component]
})

const echo = tool({
  spec: { name: "echo", description: "echo", inputSchema: { type: "object" } },
  run: (input) => Effect.succeed(input)
})

const rootActor = assembled(infer([ask([echo]), nativeOutput], TEST_MODEL))
const rootReactor = (events: ReadonlyArray<Event>) => enabled(rootActor, events)

const rest = Layer.mergeAll(
  Layer.succeed(ThreadAllocator, { allocate: () => Effect.die(new Error("unexpected child allocation")) }),
  KeyValueStore.layerMemory,
  Layer.succeed(Router, {
    send: () => Effect.void
  }),
  Layer.succeed(Self, parseThreadAddress("test-agent:main:main")),
  Layer.succeed(NativeOutputSupport, { withTools: true }),
  Layer.succeed(Infer, { react: () => Effect.die("the ask guard never asks the model") })
)

const dispatch = async (log: ReadonlyArray<Event>): Promise<ReadonlyArray<Event>> => {
  const events: Event[] = [...log]
  const memory = Layer.succeed(EventLog, withWatermark({
    append: (more: ReadonlyArray<Event>) => Effect.sync(() => void events.push(...more)),
    read: Effect.sync(() => events as ReadonlyArray<Event>)
  }))
  const derived = rootReactor(events)
  if (derived.length > 0) {
    const transition = derived[0]!
    const out = transition.kind === "intent"
      ? transition.events(transition.input, 0)
      : await Effect.runPromise(
          transition.act(transition.input, new AbortController().signal).pipe(Effect.provide(Layer.mergeAll(memory, rest)))
        )
    events.push(...out)
  }
  return events.slice(log.length)
}

const asked = (extra: Event[] = []): Event[] => [
  { type: "MessageReceived", id: "m1", text: "go", at: 0 },
  { type: "ToolCalled", callId: "a1", name: ASK_TOOL_NAME, arguments: { prompt: "Approve the release?", schema: APPROVAL }, turn: "m1", at: 1 },
  ...extra
]

describe("ask", () => {
  test("the ask tool is offered beside child tools", () => {
    const rendered = renderOf([ask([echo]), nativeOutput], [])
    expect(rendered.tools.map((item) => item.name)).toEqual(["echo", ASK_TOOL_NAME])
    expect(rendered.system).toContain("call ask with a prompt and a JSON Schema")
  })

  test("a mounted schema is the only ask argument and is validated at construction", () => {
    const rendered = renderOf([ask([echo], { schema: APPROVAL }), nativeOutput], [])
    expect(rendered.tools[1]?.inputSchema).toEqual({
      type: "object",
      properties: { prompt: expect.any(Object) },
      required: ["prompt"],
      additionalProperties: false
    })
    expect(rendered.system).toContain("the schema this assembly mounted")
    expect(() => ask([echo], { schema: { type: "string" } })).toThrow("ask schema is not declarable")
    expect(() => ask([echo], { timeoutMs: 0 })).toThrow("ask timeoutMs must be a positive safe integer")
  })

  test("calling ask records AskRequested and parks the turn", async () => {
    const out = await dispatch(asked())
    expect(out).toMatchObject([{ type: "AskRequested", callId: "a1", prompt: "Approve the release?", turn: "m1" }])
    expect(agentKeys.keyOf(out[0]!)).toBe("ar:a1")
    const parked = [...asked(), ...out]
    expect(await dispatch(parked)).toEqual([])
    expect(boundaryOf(parked, "m1")).toEqual({
      kind: "asking",
      callId: "a1",
      prompt: "Approve the release?",
      schema: APPROVAL
    })
    expect(turnViewOf(parked, "m1")).toEqual({
      turn: "m1",
      status: "parked",
      epoch: 0,
      ask: { kind: "schema", callId: "a1", prompt: "Approve the release?", schema: APPROVAL }
    })
  })

  test("AskAnswered unparks with the typed value", async () => {
    const parked = asked([{
      type: "AskRequested",
      callId: "a1",
      prompt: "Approve the release?",
      schema: APPROVAL,
      turn: "m1",
      at: 2
    }])
    const out = await dispatch([
      ...parked,
      { type: "AskAnswered", callId: "a1", answer: { approved: true }, turn: "m1", at: 3 }
    ])
    expect(out).toMatchObject([{ type: "ToolReturned", callId: "a1", result: { answered: { approved: true } } }])
    expect(boundaryOf([...parked, { type: "AskAnswered", callId: "a1", answer: { approved: true }, turn: "m1", at: 3 }], "m1")).toBeUndefined()
  })

  test("AskDenied unparks with the denial", async () => {
    const parked = asked([{
      type: "AskRequested",
      callId: "a1",
      prompt: "Approve the release?",
      schema: APPROVAL,
      turn: "m1",
      at: 2
    }])
    const out = await dispatch([
      ...parked,
      { type: "AskDenied", callId: "a1", reason: "needs review", turn: "m1", at: 3 }
    ])
    expect(out).toMatchObject([{ type: "ToolReturned", callId: "a1", result: { denied: true, reason: "needs review" } }])
    expect(agentKeys.keyOf({ type: "AskDenied", callId: "a1", turn: "m1", at: 3 })).toBe("adec:a1")
    expect(agentKeys.keyOf({ type: "AskAnswered", callId: "a1", answer: {}, turn: "m1", at: 3 })).toBe("adec:a1")
  })

  test("an invalid schema does not park", async () => {
    const out = await dispatch([
      { type: "MessageReceived", id: "m1", text: "go", at: 0 },
      { type: "ToolCalled", callId: "a1", name: ASK_TOOL_NAME, arguments: { prompt: "Approve?", schema: { type: "string" } }, turn: "m1", at: 1 }
    ])
    expect(out[0]!.type).toBe("ToolReturned")
    expect(String((out[0] as { result?: { error?: string } }).result?.error)).toContain("ask schema is not declarable")
    expect(boundaryOf([
      { type: "MessageReceived", id: "m1", text: "go", at: 0 },
      { type: "ToolCalled", callId: "a1", name: ASK_TOOL_NAME, arguments: { prompt: "Approve?", schema: { type: "string" } }, turn: "m1", at: 1 },
      ...out
    ], "m1")).toBeUndefined()
  })

  test("an invalid answer is a tool error so the model can ask again", async () => {
    const out = await dispatch(asked([
      { type: "AskRequested", callId: "a1", prompt: "Approve the release?", schema: APPROVAL, turn: "m1", at: 2 },
      { type: "AskAnswered", callId: "a1", answer: { approved: "yes" }, turn: "m1", at: 3 }
    ]))
    expect(out[0]!.type).toBe("ToolReturned")
    expect(String((out[0] as { result?: { error?: string } }).result?.error)).toContain("ask answer misses the schema")
  })

  test("an empty prompt is refused", async () => {
    const out = await dispatch([
      { type: "MessageReceived", id: "m1", text: "go", at: 0 },
      { type: "ToolCalled", callId: "a1", name: ASK_TOOL_NAME, arguments: { prompt: "  ", schema: APPROVAL }, turn: "m1", at: 1 }
    ])
    expect(String((out[0] as { result?: { error?: string } }).result?.error)).toContain("ask takes prompt as a nonempty string")
  })

  test("the authority option records an outgoing requestAsk call", () => {
    const source = threadAddressOf("agent", "main", "parent")
    const target = threadAddressOf("agent", "main", "child")
    const log: Event[] = [
      {
        type: "MessageReceived",
        id: "m1",
        text: "go",
        link: linkOf(source, target),
        at: 0
      },
      { type: "ToolCalled", callId: "a1", name: ASK_TOOL_NAME, arguments: { prompt: "Approve?", schema: APPROVAL }, turn: "m1", at: 1 },
      { type: "AskRequested", callId: "a1", prompt: "Approve the release?", schema: APPROVAL, turn: "m1", at: 2 }
    ]
    const definition = assembled(infer([ask([echo], { authority: askCaller() }), nativeOutput], TEST_MODEL))
    const planned = enabled(definition, log).find((transition) => transition.key.includes("ask.plan"))
    expect(planned?.kind).toBe("intent")
    const events = planned?.kind === "intent" ? planned.events(planned.input, 3) : []
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "CallPlanned",
        method: "requestAsk",
        input: expect.objectContaining({ request: "a1", turn: "m1", prompt: "Approve the release?" })
      })
    ]))
    expect(componentContractOf(ask([echo], { authority: askCaller() })).calls).toEqual([{
      target: { kind: "caller", methods: { requestAsk: requestAskMethod } },
      method: requestAskMethod
    }])
  })
})

describe("ask park then answer then resume", () => {
  const ROOT_THREAD = "ag.root"

  const hosted = (mind: (request: InferRequest) => Promise<Action>) => {
    const definition = assembled(infer([ask([echo]), nativeOutput], TEST_MODEL))
    const layersFor = (_thread: string): ThreadEnv<AgentR | NativeOutputSupport> =>
      Layer.mergeAll(
        KeyValueStore.layerMemory,
        Layer.succeed(Infer, {
          react: (request: InferRequest) => Effect.promise(() => mind(request))
        }),
        Layer.succeed(NativeOutputSupport, { withTools: true })
      )
    const host: Host = createHost({
      actorName: "mem",
      actorInstance: "main",
      actorFor: () => definition,
      keyOf: actorRuntimeOf(definition).keyOf,
      layersFor
    })
    return { host }
  }

  test("a typed answer resumes inference with the schema value", async () => {
    const mind = async (request: InferRequest): Promise<Action> => {
      const returned = request.trajectory.find((event) => event.type === "ToolReturned" && event.turn === request.identity.turn)
      if (returned !== undefined) {
        return { kind: "complete", output: JSON.stringify((returned as { result?: unknown }).result) }
      }
      return {
        kind: "calls",
        calls: [{ callId: "a1", name: ASK_TOOL_NAME, arguments: { prompt: "Approve the release?", schema: APPROVAL } }]
      }
    }
    const { host } = hosted(mind)
    await host.commitRoot(host.self(ROOT_THREAD), { type: "MessageReceived", id: "m1", text: "go", at: 1 } as Event)
    await host.drive()
    const parked = host.read(ROOT_THREAD)
    expect(boundaryOf(parked, "m1")?.kind).toBe("asking")
    expect(turnViewOf(parked, "m1").status).toBe("parked")
    await host.commitRoot(host.self(ROOT_THREAD), {
      type: "AskAnswered",
      callId: "a1",
      answer: { approved: true },
      turn: "m1",
      at: 50
    } as Event)
    await host.drive()
    const done = host.read(ROOT_THREAD)
    expect(boundaryOf(done, "m1")).toEqual({ kind: "completed", output: JSON.stringify({ answered: { approved: true } }) })
    expect(turnViewOf(done, "m1")).toMatchObject({ turn: "m1", status: "completed" })
  })
})
