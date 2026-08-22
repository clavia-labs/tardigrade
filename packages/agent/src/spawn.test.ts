import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { Self } from "@clavia/tardigrade-core/actor"
import { Facets } from "@clavia/tardigrade-core/facets"
import { createHost } from "@clavia/tardigrade-host/host"
import { replyId } from "@clavia/tardigrade-core/communication/message"
import { Park } from "@clavia/tardigrade-code/errors"
import { agentsPackage, INLINE_OUTPUT_NAME } from "./spawn"
import { output, type OutputContract } from "./output"
import {
  formatActorAddress,
  parseActorAddress,
  type ActorAddress,
  type ProviderAddress
} from "@clavia/tardigrade-core/communication/address"
import type { Link } from "@clavia/tardigrade-core/communication/link"

// The package is a value: its three privileges arrive as services, so a test binds them the way
// a host does and the same value runs anywhere.

const REFUSED = Effect.succeed({ error: "no synchronous calls" })
type SentLink = Link<ActorAddress, ActorAddress> | Link<ActorAddress, ProviderAddress>
type Sent = { readonly link: SentLink; readonly event: Event }

const env = (
  lane: string,
  sent: Array<Sent>,
  lanes: Readonly<Record<string, ReadonlyArray<Event>>> = {},
  router: { readonly resume?: () => Effect.Effect<{ output?: string; error?: string }> } = {}
) =>
  Layer.mergeAll(
    Layer.succeed(Router, {
      deliver: (link, event) => Effect.sync(() => void sent.push({ link, event })),
      call: () => REFUSED,
      resume: router.resume ?? (() => REFUSED)
    }),
    Layer.succeed(Self, parseActorAddress(lane)),
    Layer.succeed(Facets, { read: (name: string) => Effect.succeed(lanes[name] ?? []) })
  )

describe("agentsPackage", () => {
  test("the default placement is the host's own sibling address", async () => {
    const host = createHost({ actorFor: () => undefined, principal: "mem" })
    const sent: Array<Sent> = []
    const pkg = agentsPackage()
    await Effect.runPromise(
      pkg.methods.run!({ text: "scout", background: true }, { callId: "c1" }).pipe(Effect.provide(env(host.self("ag.root"), sent)))
    )
    // Parity with the closure the in-process host used to pass: same principal, `ag.<callId>`
    // for the lane.
    expect(sent[0]?.link.target).toEqual({ actor: "mem", thread: "ag.c1" })
  })

  test("a stated place overrides the default", async () => {
    const sent: Array<Sent> = []
    const pkg = agentsPackage({
      place: (callId, self) => ({
        actor: "far",
        thread: `${formatActorAddress(self)}/${callId}`
      })
    })
    await Effect.runPromise(
      pkg.methods.run!({ text: "scout", background: true }, { callId: "c2" }).pipe(Effect.provide(env("mem:ag.root", sent)))
    )
    expect(formatActorAddress(sent[0]!.link.target as ActorAddress)).toBe("far:mem:ag.root/c2")
  })

  test("the callId is the child's identity and the brief's id", async () => {
    const sent: Array<Sent> = []
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
    const sent: Array<Sent> = []
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
    expect(formatActorAddress(sent[0]!.link.target as ActorAddress)).toBe("mem:ag.c5")
  })

  test("result reads the lane through Facets", async () => {
    const sent: Array<Sent> = []
    const pkg = agentsPackage()
    const lanes = {
      "ag.root": [
        { type: "PackageCalled", callId: "c6", name: "agents.run", arguments: { text: "go", background: true }, at: 0 },
        { type: "MessageReceived", id: replyId("c6"), outcome: "failed", text: "error: nope", at: 1 }
      ]
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

  // The two durable facts: the parent's own record of the run, which says whether structure was
  // asked for, and the child's brief, which says under which contract.
  const lanes = (declaration: unknown, text: string, options: { readonly child?: boolean } = {}) =>
    ({
      "ag.root": [
        {
          type: "PackageCalled",
          callId: "b1",
          name: "agents.run",
          arguments: { text: "go", background: true, ...(declaration === undefined ? {} : { output: "scout" }) },
          at: 0
        },
        { type: "MessageReceived", id: replyId("b1"), outcome: "completed", text, at: 2 }
      ],
      ...(options.child === false
        ? {}
        : {
            "ag.b1": [
              {
                type: "MessageReceived",
                id: "b1",
                text: "go",
                ...(declaration === undefined ? {} : { output: declaration }),
                at: 1
              }
            ]
          })
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

  // A run known to have asked for structure whose declaration cannot be read fails closed.
  // Answering with the text would erase a contract that is known to exist.
  test("a declaration that cannot be read fails the read, never returns the text", async () => {
    const answered = await resultOf(lanes(declarationA, structured, { child: false }))
    expect((answered as { error?: string }).error).toContain('the original output declaration for run "b1" is unavailable')
  })

  test("a run nobody recorded here cannot be awaited", async () => {
    const answered = await resultOf({
      "ag.root": [{ type: "MessageReceived", id: replyId("b1"), outcome: "completed", text: structured, at: 1 }]
    } as Readonly<Record<string, ReadonlyArray<Event>>>)
    expect((answered as { error?: string }).error).toContain("no agents.run with id")
  })

  test("continue recovers the same declaration, so a rewritten handle changes nothing", async () => {
    const sent: Array<Sent> = []
    const pkg = agentsPackage({ outputs: { scout: SCOUT_B } })
    const answered = await Effect.runPromise(
      pkg.methods
        .continue!({ handle: { address: "mem:ag.b1", turn: "b1" }, grant: 1 }, { callId: "later" })
        .pipe(
          Effect.provide(
            env("mem:ag.root", sent, lanes(declarationA, structured), { resume: () => Effect.succeed({ output: structured }) })
          )
        )
    )
    // Schema A read it, though the package now declares B under the same name.
    expect(answered).toEqual({ output: { summary: "done" } })
  })
})
