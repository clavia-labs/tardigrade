import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { Self } from "@clavia/tardigrade-core/reconciliation"
import { createHost } from "@clavia/tardigrade-host/host"
import { boundaryId, replyId } from "@clavia/tardigrade-core/communication/message"
import { Park } from "@clavia/tardigrade-code/execution/errors"
import { agentsPackage, INLINE_OUTPUT_NAME } from "./agents"
import { output, type OutputContract } from "../output/contract"
import {
  formatActorId,
  parseActorId,
  type ActorId,
  type ProviderEndpoint
} from "@clavia/tardigrade-core/communication/endpoint"
import type { Link } from "@clavia/tardigrade-core/communication/link"
import type { Envelope } from "@clavia/tardigrade-core/communication/envelope"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { threadCreated } from "@clavia/tardigrade-core/thread"
import { codeSystemFor } from "../components/code"

// The package is a value: its three privileges arrive as services, so a test binds them the way
// a host does and the same value runs anywhere.

type SentLink = Link<ActorId, ActorId> | Link<ActorId, ProviderEndpoint>
type Sent = Envelope<ActorId, Event, SentLink["target"]>

const env = (
  lane: string,
  sent: Array<Sent>,
  lanes: Readonly<Record<string, ReadonlyArray<Event>>> = {}
) => {
  const self = parseActorId(lane)
  const events = [threadCreated(self, undefined, 0), ...(lanes[self.thread] ?? [])]
  return Layer.mergeAll(
    Layer.succeed(Router, {
      send: (envelope) => Effect.sync(() => void sent.push(envelope as Sent))
    }),
    Layer.succeed(Self, self),
    Layer.succeed(EventLog, withWatermark({
      append: () => Effect.void,
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
  from: `mem:ag.${turn}`,
  at: options.at ?? 1
})

describe("agentsPackage", () => {
  test("the code contract keeps run terminal while escalation stays internal", () => {
    const system = codeSystemFor([agentsPackage()])
    expect(system).not.toContain("agents.continue")
    expect(system).toContain("agents.run({text: string, background?: boolean, output?: unknown, budget?: number, escalatable?: boolean}) -> {output?: unknown, error?: string, dispatched?: boolean, callId?: string}")
  })

  test("the default placement is the host's own sibling address", async () => {
    const host = createHost({ actorFor: () => undefined, principal: "mem" })
    const sent: Array<Sent> = []
    const pkg = agentsPackage()
    await Effect.runPromise(
      pkg.methods.run!({ text: "scout", background: true, escalatable: true }, { callId: "c1" }).pipe(Effect.provide(env(host.self("ag.root"), sent)))
    )
    // Parity with the closure the in-process host used to pass: same principal, `ag.<callId>`
    // for the lane.
    expect(sent[0]?.link.target).toEqual({ actor: "mem", thread: "ag.c1" })
    expect(sent[0]?.event).toMatchObject({ escalatable: true })
  })

  test("a stated place overrides the default", async () => {
    const sent: Array<Sent> = []
    const pkg = agentsPackage({
      place: (callId, self) => ({
        actor: "far",
        thread: `${formatActorId(self)}/${callId}`
      })
    })
    await Effect.runPromise(
      pkg.methods.run!({ text: "scout", background: true }, { callId: "c2" }).pipe(Effect.provide(env("mem:ag.root", sent)))
    )
    expect(formatActorId(sent[0]!.link.target as ActorId)).toBe("far:mem:ag.root/c2")
  })

  test("the callId is the child's identity and the link returns to the parent", async () => {
    const sent: Array<Sent> = []
    const pkg = agentsPackage()
    const answer = await Effect.runPromise(
      pkg.methods.run!({ text: "scout", background: true }, { callId: "c3" }).pipe(Effect.provide(env("mem:ag.root", sent)))
    )
    expect(answer).toEqual({ dispatched: true, callId: "c3" })
    const brief = sent[0]!.event as { id?: unknown }
    expect(brief.id).toBe("c3")
    expect(sent[0]!.link).toEqual({
      source: { actor: "mem", thread: "ag.root" },
      target: { actor: "mem", thread: "ag.c3" }
    })
  })

  test("the package fixes a child model outside the tool input", async () => {
    const selected = { provider: "openrouter", model_id: "anthropic/claude-sonnet-4-6" } as const
    const sent: Array<Sent> = []
    const inherited = agentsPackage()
    const fixed = agentsPackage({ model: selected })
    await Effect.runPromise(
      inherited.methods.run!({ text: "default pass", background: true }, { callId: "model-1" }).pipe(Effect.provide(env("mem:ag.root", sent)))
    )
    await Effect.runPromise(
      fixed.methods.run!({ text: "fixed pass", background: true }, { callId: "model-2" }).pipe(Effect.provide(env("mem:ag.root", sent)))
    )
    expect(sent[0]!.event).not.toHaveProperty("model")
    expect(sent[1]!.event).toMatchObject({ model: selected })
    const refused = await Effect.runPromise(
      fixed.methods.run!({ text: "other", background: true, model: selected }, { callId: "model-3" }).pipe(Effect.provide(env("mem:ag.root", sent)))
    )
    expect(refused).toEqual({ error: "agents.run does not take model; configure agentsPackage({ model })" })
    expect(sent).toHaveLength(2)
    expect(codeSystemFor([fixed])).not.toContain("model:")
  })

  test("a reply already on the lane answers without parking", async () => {
    const sent: Array<Sent> = []
    const pkg = agentsPackage()
    const lanes = {
      "ag.root": [response("c4", "completed", "4")]
    } as Readonly<Record<string, ReadonlyArray<Event>>>
    const answer = await Effect.runPromise(
      pkg.methods.run!({ text: "sum 2+2" }, { callId: "c4" }).pipe(Effect.provide(env("mem:ag.root", sent, lanes)))
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
        Effect.provide(env("mem:ag.root", sent)),
        Effect.flip,
        Effect.orDie
      )
    )
    expect(parked).toBeInstanceOf(Park)
    expect((parked as Park).awaiting).toBe(replyId("c5"))
    expect(formatActorId(sent[0]!.link.target as ActorId)).toBe("mem:ag.c5")
  })

  test("result reads the response from its own log", async () => {
    const sent: Array<Sent> = []
    const pkg = agentsPackage()
    const lanes = {
      "ag.root": [
        response("c6", "failed", "nope")
      ]
    } as Readonly<Record<string, ReadonlyArray<Event>>>
    const answer = await Effect.runPromise(
      pkg.methods.result!({ id: "c6" }, { callId: "c7" }).pipe(Effect.provide(env("mem:ag.root", sent, lanes)))
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
      pkg.methods.run!({ text: "draft", budget: 0.7 }, { callId: "c8" }).pipe(Effect.provide(env("mem:ag.root", sent)))
    )
    expect(answer).toEqual({ error: "agents.run takes budget as a whole number of tool calls, at least 1; got 0.7" })
    expect(draws.length).toBe(0)
    expect(sent.length).toBe(0)
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
        .pipe(Effect.provide(env("mem:ag.root", sent)))
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
  const lanes = (declaration: unknown, text: string) => ({
    "ag.root": [response("b1", "completed", text, {
      data: declaration === undefined ? undefined : { output: declaration },
      at: 2
    })]
  }) as Readonly<Record<string, ReadonlyArray<Event>>>

  const resultOf = async (
    lanesFor: Readonly<Record<string, ReadonlyArray<Event>>>,
    outputs: Readonly<Record<string, OutputContract>> = {}
  ): Promise<unknown> => {
    const sent: Array<Sent> = []
    const pkg = agentsPackage({ outputs })
    return Effect.runPromise(
      pkg.methods.result!({ id: "b1" }, { callId: "later" }).pipe(Effect.provide(env("mem:ag.root", sent, lanesFor)))
    )
  }

  const declarationA = { name: SCOUT.name, schema: SCOUT.schema }

  test("a run that declared a contract comes back decoded and validated", async () => {
    expect(await resultOf(lanes(declarationA, structured), { scout: SCOUT })).toEqual({ output: { summary: "done" } })
  })

  test("a later call cannot invent a contract the run never declared", async () => {
    // The reply is JSON that would satisfy a contract nobody asked for. The run declared none, so
    // it comes back as the text it is.
    expect(await resultOf(lanes(undefined, structured), { scout: SCOUT })).toEqual({ output: structured })
  })

  // The three cases the durable log has to settle: the run was started under schema A, and only
  // schema A can read its answer, whatever is mounted when the answer is read.
  test("the answer stays bound to schema A when the registry now holds schema B", async () => {
    expect(await resultOf(lanes(declarationA, structured), { scout: SCOUT_B })).toEqual({ output: { summary: "done" } })
  })

  test("the answer stays readable when the registry entry is gone entirely", async () => {
    expect(await resultOf(lanes(declarationA, structured))).toEqual({ output: { summary: "done" } })
  })

  test("a reply invalid under A but valid under B still fails as A", async () => {
    const answered = await resultOf(lanes(declarationA, '{"summary":7}'), { scout: SCOUT_B })
    expect((answered as { error?: string }).error).toContain('outside its declared contract "scout"')
  })

  test("a reply outside the run's declared contract is an error, never a value", async () => {
    const answered = await resultOf(lanes(declarationA, '{"summary":7}'), { scout: SCOUT })
    expect((answered as { error?: string }).error).toContain('outside its declared contract "scout"')
  })

  // A carried declaration that cannot be read fails closed.
  test("a declaration that cannot be read fails the read, never returns the text", async () => {
    const answered = await resultOf(lanes(null, structured))
    expect((answered as { error?: string }).error).toContain('the original output declaration for run "b1" is unavailable')
  })

})
