import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { Router } from "@clavia/tardigrade-core/router"
import { Self } from "@clavia/tardigrade-core/actor"
import { Facets } from "@clavia/tardigrade-core/facets"
import { createHost } from "@clavia/tardigrade-host/host"
import { replyId } from "@clavia/tardigrade-core/message"
import { Park } from "@clavia/tardigrade-code/errors"
import { agentsPackage, INLINE_OUTPUT_NAME } from "./spawn"
import { output } from "./output"

// The package is a value: its three privileges arrive as services, so a test binds them the way
// a host does and the same value runs anywhere.

const REFUSED = Effect.succeed({ error: "no synchronous calls" })

const env = (
  lane: string,
  sent: Array<{ readonly address: string; readonly event: Event }>,
  lanes: Readonly<Record<string, ReadonlyArray<Event>>> = {}
) =>
  Layer.mergeAll(
    Layer.succeed(Router, {
      deliver: (address: string, event: Event) => Effect.sync(() => void sent.push({ address, event })),
      call: () => REFUSED,
      resume: () => REFUSED
    }),
    Layer.succeed(Self, lane),
    Layer.succeed(Facets, { read: (name: string) => Effect.succeed(lanes[name] ?? []) })
  )

describe("agentsPackage", () => {
  test("the default placement is the host's own sibling address", async () => {
    const host = createHost({ actorFor: () => undefined, principal: "mem" })
    const sent: Array<{ readonly address: string; readonly event: Event }> = []
    const pkg = agentsPackage()
    await Effect.runPromise(
      pkg.methods.run!({ text: "scout", background: true }, { callId: "c1" }).pipe(Effect.provide(env(host.self("ag.root"), sent)))
    )
    // Parity with the closure the in-process host used to pass: same principal, `ag.<callId>`
    // for the lane.
    expect(sent[0]?.address).toBe(host.self("ag.c1"))
  })

  test("a stated place overrides the default", async () => {
    const sent: Array<{ readonly address: string; readonly event: Event }> = []
    const pkg = agentsPackage({ place: (callId, self) => `far:${self}/${callId}` })
    await Effect.runPromise(
      pkg.methods.run!({ text: "scout", background: true }, { callId: "c2" }).pipe(Effect.provide(env("mem:ag.root", sent)))
    )
    expect(sent[0]?.address).toBe("far:mem:ag.root/c2")
  })

  test("the callId is the child's identity and the brief's id", async () => {
    const sent: Array<{ readonly address: string; readonly event: Event }> = []
    const pkg = agentsPackage()
    const answer = await Effect.runPromise(
      pkg.methods.run!({ text: "scout", background: true }, { callId: "c3" }).pipe(Effect.provide(env("mem:ag.root", sent)))
    )
    expect(answer).toEqual({ dispatched: true, callId: "c3" })
    const brief = sent[0]!.event as { id?: unknown; replyTo?: unknown }
    expect(brief.id).toBe("c3")
    expect(brief.replyTo).toBe("mem:ag.root")
  })

  test("a reply already on the lane answers without parking", async () => {
    const sent: Array<{ readonly address: string; readonly event: Event }> = []
    const pkg = agentsPackage()
    const lanes = {
      "ag.root": [{ type: "MessageReceived", id: replyId("c4"), outcome: "completed", text: "4", at: 1 }]
    } as Readonly<Record<string, ReadonlyArray<Event>>>
    const answer = await Effect.runPromise(
      pkg.methods.run!({ text: "sum 2+2" }, { callId: "c4" }).pipe(Effect.provide(env("mem:ag.root", sent, lanes)))
    )
    expect(answer).toEqual({ output: "4" })
    // The observe privilege answered, so nothing was re-delivered.
    expect(sent.length).toBe(0)
  })

  test("a foreground run with no reply yet parks on the reply row", async () => {
    const sent: Array<{ readonly address: string; readonly event: Event }> = []
    const pkg = agentsPackage()
    const parked = await Effect.runPromise(
      pkg.methods.run!({ text: "sum 2+2" }, { callId: "c5" }).pipe(Effect.provide(env("mem:ag.root", sent)), Effect.flip)
    )
    expect(parked).toBeInstanceOf(Park)
    expect((parked as Park).awaiting).toBe(replyId("c5"))
    expect(sent[0]?.address).toBe("mem:ag.c5")
  })

  test("result reads the lane through Facets", async () => {
    const sent: Array<{ readonly address: string; readonly event: Event }> = []
    const pkg = agentsPackage()
    const lanes = {
      "ag.root": [{ type: "MessageReceived", id: replyId("c6"), outcome: "failed", text: "error: nope", at: 1 }]
    } as Readonly<Record<string, ReadonlyArray<Event>>>
    const answer = await Effect.runPromise(
      pkg.methods.result!({ id: "c6" }, { callId: "c7" }).pipe(Effect.provide(env("mem:ag.root", sent, lanes)))
    )
    expect(answer).toEqual({ error: "nope" })
  })
})

// The contracts a host declares for its children. A name resolves to one of these; anything else
// a code body invents is a raw schema, and the profile check is what stands in for the compile
// step model-authored JavaScript never had (packages/code/src/execute.ts runs it through
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
    const sent: Array<{ readonly address: string; readonly event: Event }> = []
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
