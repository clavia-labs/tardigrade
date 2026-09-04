import { describe, expect, test } from "bun:test"
import { Cause, Effect, Layer } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { Self } from "@clavia/tardigrade-core/runtime"
import { createHost } from "@clavia/tardigrade-host/host"
import { boundaryId, replyId } from "@clavia/tardigrade-core/communication/message"
import { Park } from "@clavia/tardigrade-code/execution/errors"
import { agentsPackage, INLINE_OUTPUT_NAME } from "./agents"
import { output, type OutputContract } from "../output/contract"
import {
  formatThreadAddress,
  parseThreadAddress,
  type ThreadAddress,
  type ProviderEndpoint
} from "@clavia/tardigrade-core/communication/endpoint"
import type { Link } from "@clavia/tardigrade-core/communication/link"
import type { Envelope } from "@clavia/tardigrade-core/communication/envelope"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { threadCreated } from "@clavia/tardigrade-core/thread"
import { codeSystemFor } from "../component/code"

// The package is a value: its three privileges arrive as services, so a test binds them the way
// a host does and the same value runs anywhere.

type SentLink = Link<ThreadAddress, ThreadAddress> | Link<ThreadAddress, ProviderEndpoint>
type Sent = Envelope<ThreadAddress, Event, SentLink["target"]>

const env = (
  thread: string,
  sent: Array<Sent>,
  threads: Readonly<Record<string, ReadonlyArray<Event>>> = {},
  appended: Array<Event> = []
) => {
  const self = parseThreadAddress(thread)
  const events = [threadCreated(self, undefined, 0), ...(threads[self.thread] ?? [])]
  return Layer.mergeAll(
    Layer.succeed(Router, {
      send: (envelope) => Effect.sync(() => void sent.push(envelope as Sent))
    }),
    Layer.succeed(Self, self),
    Layer.succeed(EventLog, withWatermark({
      append: (committed) => Effect.sync(() => void appended.push(...committed)),
      read: Effect.succeed(events)
    }))
  )
}

const response = (
  turn: string,
  status: "completed" | "failed",
  value: string,
  options: { readonly round?: number; readonly data?: unknown; readonly at?: number } = {}
): Event => ({
  type: "ResponseReceived",
  id: boundaryId(turn, options.round ?? 0),
  method: "message",
  call: turn,
  status,
  ...(status === "completed" ? { output: value } : {}),
  ...(status === "failed" ? { error: value } : {}),
  ...(options.data === undefined ? {} : { data: options.data }),
  from: `mem:main:ag.${turn}`,
  at: options.at ?? 1
})

// A spawn reads its parent run off the log: the turn head serving it and the package call that
// recorded it (agents.ts, parentRunOf).
const turn = (id: string, at = 1): Event =>
  ({ type: "MessageReceived", id, text: "delegate", at } as Event)
const called = (callId: string, turnId: string, at = 2): Event =>
  ({ type: "PackageCalled", callId, name: "agents.run", arguments: {}, turn: turnId, at } as Event)

describe("agentsPackage", () => {
  test("a foreground child records its invocation owner", async () => {
    const sent: Array<Sent> = []
    const appended: Array<Event> = []
    const pkg = agentsPackage()
    const events = [turn("m1"), {
      type: "PackageCalled",
      callId: "child-1",
      name: "agents.run",
      arguments: {},
      turn: "m1",
      epoch: 2,
      at: 1
    } as Event]
    const parked = await Effect.runPromise(
      pkg.methods.run!({ text: "scout" }, { callId: "child-1" }).pipe(
        Effect.provide(env("mem:main:ag.root", sent, { "ag.root": events }, appended)),
        Effect.flip,
        Effect.orDie
      )
    )

    expect(parked).toBeInstanceOf(Park)
    expect(appended).toContainEqual(expect.objectContaining({
      type: "InvocationLinked",
      parent: { method: "message", id: "m1", epoch: 2 },
      child: expect.objectContaining({ invocation: { method: "message", id: "child-1", epoch: 0 } }),
      target: "mem:main:ag.2:m1child-1"
    }))
    expect(sent[0]?.call).toMatchObject({
      parent: { method: "message", id: "m1", epoch: 2 },
      invocation: { method: "message", id: "child-1", epoch: 0 }
    })
  })

  test("the code contract keeps run terminal while escalation stays internal", () => {
    const system = codeSystemFor([agentsPackage()])
    expect(system).not.toContain("agents.continue")
    expect(system).toContain("agents.providers({cursor?: string, search?: string, limit?: number})")
    expect(system).toContain("agents.models({cursor?: string, search?: string, limit?: number, provider?: string, sort?: \"promptUsdPerToken\" | \"completionUsdPerToken\" | \"cachedPromptUsdPerToken\" | \"cacheWritePromptUsdPerToken\", order?: \"asc\" | \"desc\", unpriced?: \"first\" | \"last\"})")
    expect(system).toContain("agents.run({text: string, background?: boolean, output?: unknown, model?: {provider: string, model_id: string}, budget?: number, placement?: \"colocated\" | \"independent\", escalatable?: boolean}) -> {output?: unknown, error?: string, dispatched?: boolean, callId?: string}")
  })

  test("catalog searches return the host API pages", async () => {
    const providerQueries: unknown[] = []
    const modelQueries: unknown[] = []
    const providerPage = {
      revision: "catalog-1",
      status: "fresh",
      refreshed_at: 1,
      policy: { allow: "*" },
      total: 1,
      limit: 10,
      items: [{ id: "openrouter", name: "OpenRouter", availability: { status: "available" }, env: ["OPENROUTER_API_KEY"], required: ["env"], optional: [] }]
    }
    const modelPage = {
      revision: "catalog-1",
      status: "fresh",
      refreshed_at: 1,
      policy: { allow: "*" },
      total: 1,
      limit: 10,
      items: [{
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4-6",
        name: "Claude Sonnet",
        metadata: {
          contextWindowTokens: 200_000,
          pricing: { promptUsdPerToken: 0.000_003, completionUsdPerToken: 0.000_015 }
        }
      }]
    }
    const pkg = agentsPackage({
      catalog: {
        providers: (query) => {
          providerQueries.push(query)
          return providerPage
        },
        models: (query) => {
          modelQueries.push(query)
          return modelPage
        }
      }
    })
    const sent: Array<Sent> = []
    const providers = await Effect.runPromise(
      pkg.methods.providers!({ search: "router", limit: 10 }, { callId: "providers" }).pipe(Effect.provide(env("mem:main:ag.root", sent)))
    )
    const models = await Effect.runPromise(
      pkg.methods.models!({
        provider: "openrouter",
        search: "claude",
        limit: 10,
        sort: "completionUsdPerToken",
        order: "asc",
        unpriced: "last"
      }, { callId: "models" }).pipe(Effect.provide(env("mem:main:ag.root", sent)))
    )
    expect(providerQueries).toEqual([{
      search: "router",
      limit: 10,
      availability: "available",
      models: { allow: "*" }
    }])
    expect(modelQueries).toEqual([{
      search: "claude",
      limit: 10,
      provider: "openrouter",
      availability: "available",
      sort: "completionUsdPerToken",
      order: "asc",
      unpriced: "last",
      models: { allow: "*" }
    }])
    expect(providers).toEqual(providerPage)
    expect(models).toEqual(modelPage)
  })

  test("the default address is the host's own sibling", async () => {
    const host = createHost({ actorFor: () => undefined, actorName: "mem" })
    const sent: Array<Sent> = []
    const pkg = agentsPackage()
    await Effect.runPromise(
      pkg.methods.run!({ text: "scout", background: true, escalatable: true }, { callId: "c1" }).pipe(
        Effect.provide(env(host.self("ag.root"), sent, { "ag.root": [turn("m1"), called("c1", "m1")] }))
      )
    )
    // Parity with the closure the in-process host used to pass: same actorName, the thread
    // named by the parent run and call (agents.ts, childThreadId).
    expect(sent[0]?.link.target).toEqual({ actor: "mem", instance: "main", thread: "ag.2:m1c1" })
    expect(sent[0]?.event).toMatchObject({ escalatable: true })
  })

  test("a run carries its requested thread placement", async () => {
    const sent: Array<Sent> = []
    const pkg = agentsPackage()
    await Effect.runPromise(
      pkg.methods.run!({ text: "scout", background: true, placement: "independent" }, { callId: "independent-child" })
        .pipe(Effect.provide(env("mem:main:ag.root", sent, { "ag.root": [turn("m1"), called("independent-child", "m1")] })))
    )
    expect(sent[0]?.lineage?.placement).toBe("independent")
  })

  test("a run refuses an unknown thread placement", async () => {
    const result = await Effect.runPromise(
      agentsPackage().methods.run!({ text: "scout", background: true, placement: "nearby" }, { callId: "bad-placement" })
        .pipe(Effect.provide(env("mem:main:ag.root", [], { "ag.root": [turn("m1"), called("bad-placement", "m1")] })))
    )
    expect(result).toEqual({ error: "agents.run placement must be colocated or independent" })
  })

  test("the callId is the child's identity and the link returns to the parent", async () => {
    const sent: Array<Sent> = []
    const pkg = agentsPackage()
    const answer = await Effect.runPromise(
      pkg.methods.run!({ text: "scout", background: true }, { callId: "c3" }).pipe(
        Effect.provide(env("mem:main:ag.root", sent, { "ag.root": [turn("m1"), called("c3", "m1")] }))
      )
    )
    expect(answer).toEqual({ dispatched: true, callId: "c3" })
    const brief = sent[0]!.event as { id?: unknown }
    expect(brief.id).toBe("c3")
    expect(sent[0]!.link).toEqual({
      source: { actor: "mem", instance: "main", thread: "ag.root" },
      target: { actor: "mem", instance: "main", thread: "ag.2:m1c3" }
    })
  })

  test("a run selects a complete child model reference", async () => {
    const selected = { provider: "openrouter", model_id: "anthropic/claude-sonnet-4-6" } as const
    const overridden = { provider: "openai", model_id: "gpt-5.6" } as const
    const sent: Array<Sent> = []
    const inherited = agentsPackage()
    const fixed = agentsPackage({ models: { default: selected, allow: "*" } })
    const calls = {
      "ag.root": [turn("m1"), called("model-1", "m1"), called("model-2", "m1"), called("model-3", "m1")]
    }
    await Effect.runPromise(
      inherited.methods.run!({ text: "default pass", background: true }, { callId: "model-1" }).pipe(Effect.provide(env("mem:main:ag.root", sent, calls)))
    )
    await Effect.runPromise(
      fixed.methods.run!({ text: "fixed pass", background: true }, { callId: "model-2" }).pipe(Effect.provide(env("mem:main:ag.root", sent, calls)))
    )
    expect(sent[0]!.event).not.toHaveProperty("model")
    expect(sent[1]!.event).toMatchObject({ model: selected })
    await Effect.runPromise(
      fixed.methods.run!({ text: "other", background: true, model: overridden }, { callId: "model-3" }).pipe(Effect.provide(env("mem:main:ag.root", sent, calls)))
    )
    expect(sent[2]!.event).toMatchObject({ model: overridden })
    expect(sent).toHaveLength(3)
    expect(codeSystemFor([fixed])).toContain("model?: {provider: string, model_id: string}")
  })

  test("a child receives the parent and package model intersection", async () => {
    const selected = { provider: "openai", model_id: "small" } as const
    const parent: Event = {
      type: "MessageReceived",
      id: "parent",
      text: "delegate",
      models: {
        allow: [{ provider: "openai", model_ids: ["large", "small"] }]
      },
      at: 1
    }
    const pkg = agentsPackage({
      models: {
        default: selected,
        allow: [
          { provider: "openai", model_ids: ["small"] },
          { provider: "anthropic", model_ids: "*" }
        ]
      }
    })
    const sent: Array<Sent> = []
    await Effect.runPromise(
      pkg.methods.run!({ text: "scout", background: true }, { callId: "narrow" }).pipe(
        Effect.provide(env("mem:main:ag.root", sent, { "ag.root": [parent, called("narrow", "parent")] }))
      )
    )
    expect(sent[0]!.event).toMatchObject({
      model: selected,
      models: { allow: [{ provider: "openai", model_ids: ["small"] }] }
    })
  })

  test("a package with no model override inherits the parent default", async () => {
    const selected = { provider: "openai", model_id: "small" } as const
    const parent: Event = {
      type: "MessageReceived",
      id: "parent",
      text: "delegate",
      models: {
        default: selected,
        allow: [{ provider: "openai", model_ids: ["large", "small"] }]
      },
      at: 1
    }
    const sent: Array<Sent> = []
    await Effect.runPromise(
      agentsPackage().methods.run!({ text: "scout", background: true }, { callId: "inherit" }).pipe(
        Effect.provide(env("mem:main:ag.root", sent, { "ag.root": [parent, called("inherit", "parent")] }))
      )
    )
    expect(sent[0]!.event).toMatchObject({
      model: selected,
      models: {
        default: selected,
        allow: [{ provider: "openai", model_ids: ["large", "small"] }]
      }
    })
  })

  test("a reply already on the thread answers without parking", async () => {
    const sent: Array<Sent> = []
    const pkg = agentsPackage()
    const threads = {
      "ag.root": [turn("m1"), called("c4", "m1"), response("c4", "completed", "4")]
    } as Readonly<Record<string, ReadonlyArray<Event>>>
    const answer = await Effect.runPromise(
      pkg.methods.run!({ text: "sum 2+2" }, { callId: "c4" }).pipe(Effect.provide(env("mem:main:ag.root", sent, threads)))
    )
    expect(answer).toEqual({ output: "4" })
    // The durable response answered, so nothing was re-delivered.
    expect(sent.length).toBe(0)
  })

  test("a foreground run with no reply yet parks on the reply row", async () => {
    const sent: Array<Sent> = []
    const pkg = agentsPackage()
    const parked = await Effect.runPromise(
      // flip then orDie: the call must park, and a success is a defect rather than a failure
      // typed as the method's own result.
      pkg.methods.run!({ text: "sum 2+2" }, { callId: "c5" }).pipe(
        Effect.provide(env("mem:main:ag.root", sent, { "ag.root": [turn("m1"), called("c5", "m1")] })),
        Effect.flip,
        Effect.orDie
      )
    )
    expect(parked).toBeInstanceOf(Park)
    expect((parked as Park).awaiting).toBe(replyId("c5"))
    expect(formatThreadAddress(sent[0]!.link.target as ThreadAddress)).toBe("mem:main:ag.2:m1c5")
  })

  test("result reads the response from its own log", async () => {
    const sent: Array<Sent> = []
    const pkg = agentsPackage()
    const threads = {
      "ag.root": [
        response("c6", "failed", "nope")
      ]
    } as Readonly<Record<string, ReadonlyArray<Event>>>
    const answer = await Effect.runPromise(
      pkg.methods.result!({ id: "c6" }, { callId: "c7" }).pipe(Effect.provide(env("mem:main:ag.root", sent, threads)))
    )
    expect(answer).toEqual({ error: "nope" })
  })

  test("a fractional budget is refused with its unit, never floored to zero", async () => {
    // The budget is a count of tool calls. 0.7 floored would draw zero and read as an exhausted
    // run, so the unit error goes back to the caller before any draw or delivery (spawn.ts, run).
    const sent: Array<Sent> = []
    const draws: number[] = []
    const pkg = agentsPackage({
      reserve: async (_id, want) => {
        draws.push(want)
        return want
      }
    })
    const answer = await Effect.runPromise(
      pkg.methods.run!({ text: "draft", budget: 0.7 }, { callId: "c8" }).pipe(
        Effect.provide(env("mem:main:ag.root", sent, { "ag.root": [turn("m1"), called("c8", "m1")] }))
      )
    )
    expect(answer).toEqual({ error: "agents.run takes budget as a whole number of tool calls, at least 1; got 0.7" })
    expect(draws.length).toBe(0)
    expect(sent.length).toBe(0)
  })

})

// A live parent log: an append lands where the next read looks, so a re-driven dispatch replays
// against what its predecessor recorded, the way a durable store does after a crash.
const liveEnv = (events: Event[], sent: Array<Sent>) => {
  const self = parseThreadAddress("mem:main:ag.root")
  return Layer.mergeAll(
    Layer.succeed(Router, {
      send: (envelope) => Effect.sync(() => void sent.push(envelope as Sent))
    }),
    Layer.succeed(Self, self),
    Layer.succeed(EventLog, withWatermark({
      append: (committed) => Effect.sync(() => void events.push(...committed)),
      read: Effect.sync(() => events)
    }))
  )
}

// A turn head served through the actor method machinery carries its call context, deadline
// included (packages/core/src/communication/envelope.test.ts, "methodEnvelopeOf").
const turnWithDeadline = (id: string, deadlineAt: number): Event =>
  ({
    type: "MessageReceived",
    id,
    text: "delegate",
    call: { invocation: { method: "message", id, epoch: 0 }, deadlineAt },
    at: 1
  } as Event)

describe("a child is named by its parent run and call", () => {
  const run = agentsPackage().methods.run!
  const background = (text: string, callId: string) =>
    run({ text, background: true }, { callId })
  const threads = (sent: ReadonlyArray<Sent>): ReadonlyArray<string> =>
    sent.map(({ link }) => (link.target as ThreadAddress).thread)

  test("reused call ids across turns address distinct children", async () => {
    const events: Event[] = [
      threadCreated(parseThreadAddress("mem:main:ag.root"), undefined, 0),
      turn("parent-a"),
      called("reused-call", "parent-a")
    ]
    const sent: Array<Sent> = []
    await Effect.runPromise(background("first", "reused-call").pipe(Effect.provide(liveEnv(events, sent))))
    events.push(
      { type: "TurnCompleted", turn: "parent-a", output: "first done", at: 4 } as Event,
      turn("parent-b"),
      called("reused-call", "parent-b")
    )
    await Effect.runPromise(background("second", "reused-call").pipe(Effect.provide(liveEnv(events, sent))))
    // The third dispatch replays the second: it reads the child the second recorded instead of
    // deriving or claiming the first turn's child.
    await Effect.runPromise(background("second", "reused-call").pipe(Effect.provide(liveEnv(events, sent))))

    expect(threads(sent)).toEqual([
      "ag.8:parent-areused-call",
      "ag.8:parent-breused-call",
      "ag.8:parent-breused-call"
    ])
    expect(events.filter((event) => event.type === "ChildCreated")).toMatchObject([
      { callId: "reused-call", turn: "parent-a", address: { thread: "ag.8:parent-areused-call" } },
      { callId: "reused-call", turn: "parent-b", address: { thread: "ag.8:parent-breused-call" } }
    ])
  })

  test("a dispatch whose creation record never committed re-derives the same address", async () => {
    // The crash window Child.tla opens between the record and the delivery: the re-driven
    // dispatch has no ChildCreated to read and must land where its predecessor was headed.
    const events: Event[] = [
      threadCreated(parseThreadAddress("mem:main:ag.root"), undefined, 0),
      turn("m1"),
      called("crash-1", "m1")
    ]
    const sent: Array<Sent> = []
    await Effect.runPromise(background("scout", "crash-1").pipe(Effect.provide(liveEnv(events, sent))))
    events.splice(events.findIndex((event) => event.type === "ChildCreated"), 1)
    await Effect.runPromise(background("scout", "crash-1").pipe(Effect.provide(liveEnv(events, sent))))
    expect(threads(sent)).toEqual(["ag.2:m1crash-1", "ag.2:m1crash-1"])
  })

  test("a creation record without a turn still names its child", async () => {
    // A record written before the turn field existed carries the address the old scheme minted;
    // the replay reads it and never records a second child.
    const events: Event[] = [
      threadCreated(parseThreadAddress("mem:main:ag.root"), undefined, 0),
      turn("m1"),
      called("legacy-1", "m1"),
      {
        type: "ChildCreated",
        callId: "legacy-1",
        address: { actor: "mem", instance: "main", thread: "ag.legacy-1" },
        depth: 1,
        at: 3
      } as Event
    ]
    const sent: Array<Sent> = []
    await Effect.runPromise(background("scout", "legacy-1").pipe(Effect.provide(liveEnv(events, sent))))
    expect(threads(sent)).toEqual(["ag.legacy-1"])
    expect(events.filter((event) => event.type === "ChildCreated")).toHaveLength(1)
  })

  test("a background child inherits the owning turn deadline without a parent link", async () => {
    const events: Event[] = [
      threadCreated(parseThreadAddress("mem:main:ag.root"), undefined, 0),
      turnWithDeadline("m1", 86_400_002),
      called("bg-1", "m1")
    ]
    const sent: Array<Sent> = []
    await Effect.runPromise(background("scout", "bg-1").pipe(Effect.provide(liveEnv(events, sent))))
    expect(sent[0]?.call).toEqual({
      invocation: { method: "message", id: "bg-1", epoch: 0 },
      deadlineAt: 86_400_002
    })
    expect(events.some((event) => event.type === "InvocationLinked")).toBe(false)
  })

  test("a run with no parent turn dies rather than naming a child", async () => {
    // The package call is what ties a dispatch to its run; a method reached outside one has no
    // child to name and no duplicate to absorb.
    const events: Event[] = [threadCreated(parseThreadAddress("mem:main:ag.root"), undefined, 0)]
    const exit = await Effect.runPromiseExit(
      background("scout", "orphan-1").pipe(Effect.provide(liveEnv(events, [])))
    )
    if (exit._tag !== "Failure") throw new Error("expected the orphaned call to die")
    expect(Cause.pretty(exit.cause)).toContain("agents.run orphan-1 has no parent turn")
  })
})

// The contracts a host declares for its children. A name resolves to one of these; anything else
// a code body invents is a raw schema, and the profile check is what stands in for the compile
// step model-authored JavaScript never had (packages/code/src/execution/reactor.ts runs it through
// AsyncFunction).
const SCOUT = output({
  name: "scout",
  schema: {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false
  }
})

describe("the output a spawn asks for", () => {
  const briefOf = async (asked: unknown, outputs?: Readonly<Record<string, typeof SCOUT>>) => {
    const sent: Array<Sent> = []
    const pkg = agentsPackage(outputs === undefined ? {} : { outputs })
    const answer = await Effect.runPromise(
      pkg.methods
        .run!({ text: "scout", background: true, output: asked }, { callId: "o1" })
        .pipe(Effect.provide(env("mem:main:ag.root", sent, { "ag.root": [turn("m1"), called("o1", "m1")] })))
    )
    return { answer, brief: sent[0]?.event as { output?: unknown } | undefined }
  }

  test("a declared name resolves to the host's own contract", async () => {
    const { brief } = await briefOf("scout", { scout: SCOUT })
    expect(brief?.output).toEqual({ name: "scout", schema: SCOUT.schema })
  })

  test("a name nobody declared is an error that lists what is declared", async () => {
    const { answer, brief } = await briefOf("scoot", { scout: SCOUT })
    expect((answer as { error?: string }).error).toContain("declared: scout")
    expect(brief).toBeUndefined()
    const bare = await briefOf("scout")
    expect((bare.answer as { error?: string }).error).toContain("this host declares none")
  })

  test("a raw schema in profile rides as an inline contract", async () => {
    const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false }
    const { brief } = await briefOf(schema)
    expect(brief?.output).toEqual({ name: INLINE_OUTPUT_NAME, schema })
  })

  test("a raw schema outside the profile is refused before the child is briefed", async () => {
    const { answer, brief } = await briefOf({ type: "object", properties: { a: { type: "string" } }, required: [] })
    expect((answer as { error?: string }).error).toContain("outside the supported profile")
    expect((answer as { error?: string }).error).toContain('missing "a"')
    // No brief left, so no child and no model was ever called.
    expect(brief).toBeUndefined()
  })

  test("an output that is neither a name nor a schema says so", async () => {
    const { answer } = await briefOf(42)
    expect((answer as { error?: string }).error).toContain("a declared contract's name or a JSON schema object")
  })

  test("an undeclared output leaves the brief alone", async () => {
    const { brief } = await briefOf(undefined)
    expect(brief?.output).toBeUndefined()
  })
})

// A run's contract is the run's own durable fact: the brief it delivered to its child. A later
// call cannot say "that was structured" and have prose reinterpreted, and a registry that changes
// afterwards cannot re-read an old answer as a different shape.
describe("a run stays bound to the schema it was started under", () => {
  const structured = JSON.stringify({ summary: "done" })
  // Two contracts under one name. The second is what a redeployment might mount tomorrow.
  const SCOUT_B = output({
    name: "scout",
    schema: {
      type: "object",
      properties: { summary: { type: "number" } },
      required: ["summary"],
      additionalProperties: false
    }
  })

  // The response carries the declaration the child accepted with its call.
  const threads = (declaration: unknown, text: string) => ({
    "ag.root": [response("b1", "completed", text, {
      data: declaration === undefined ? undefined : { output: declaration },
      at: 2
    })]
  }) as Readonly<Record<string, ReadonlyArray<Event>>>

  const resultOf = async (
    threadsFor: Readonly<Record<string, ReadonlyArray<Event>>>,
    outputs: Readonly<Record<string, OutputContract>> = {}
  ): Promise<unknown> => {
    const sent: Array<Sent> = []
    const pkg = agentsPackage({ outputs })
    return Effect.runPromise(
      pkg.methods.result!({ id: "b1" }, { callId: "later" }).pipe(Effect.provide(env("mem:main:ag.root", sent, threadsFor)))
    )
  }

  const declarationA = { name: SCOUT.name, schema: SCOUT.schema }

  test("a run that declared a contract comes back decoded and validated", async () => {
    expect(await resultOf(threads(declarationA, structured), { scout: SCOUT })).toEqual({ output: { summary: "done" } })
  })

  test("a later call cannot invent a contract the run never declared", async () => {
    // The reply is JSON that would satisfy a contract nobody asked for. The run declared none, so
    // it comes back as the text it is.
    expect(await resultOf(threads(undefined, structured), { scout: SCOUT })).toEqual({ output: structured })
  })

  // The three cases the durable log has to settle: the run was started under schema A, and only
  // schema A can read its answer, whatever is mounted when the answer is read.
  test("the answer stays bound to schema A when the registry now holds schema B", async () => {
    expect(await resultOf(threads(declarationA, structured), { scout: SCOUT_B })).toEqual({ output: { summary: "done" } })
  })

  test("the answer stays readable when the registry entry is gone entirely", async () => {
    expect(await resultOf(threads(declarationA, structured))).toEqual({ output: { summary: "done" } })
  })

  test("a reply invalid under A but valid under B still fails as A", async () => {
    const answered = await resultOf(threads(declarationA, '{"summary":7}'), { scout: SCOUT_B })
    expect((answered as { error?: string }).error).toContain('outside its declared contract "scout"')
  })

  test("a reply outside the run's declared contract is an error, never a value", async () => {
    const answered = await resultOf(threads(declarationA, '{"summary":7}'), { scout: SCOUT })
    expect((answered as { error?: string }).error).toContain('outside its declared contract "scout"')
  })

  // A carried declaration that cannot be read fails closed.
  test("a declaration that cannot be read fails the read, never returns the text", async () => {
    const answered = await resultOf(threads(null, structured))
    expect((answered as { error?: string }).error).toContain('the original output declaration for run "b1" is unavailable')
  })

})
