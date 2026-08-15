import { describe, expect, test } from "bun:test"
import { Context, Effect } from "effect"
import { machine, type Event } from "@flamecast/core"
import { customInference, type NativeTool } from "./infer"
import { WITHDRAW_ALL } from "./definition"
import { createAgent, defineModule, undeclaredEvents } from "./module"
import { morphCompaction } from "./modules/compaction"
import { inference, InferenceStateProjection } from "./modules/inference"
import { nativeTools } from "./modules/native-tools"
import { defaultPack } from "./pack"
import type { Projection } from "./projection"

const lookupInvoice: NativeTool = {
  spec: {
    name: "lookup_invoice",
    description: "Look up one invoice by its order id.",
    inputSchema: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"]
    }
  },
  run: () => Effect.succeed({ total: "312.00" })
}

// The checks that serve a module tuple built by generated code, where no compiler ran. Each one
// names a mistake that is silent at runtime: a transition that waits forever, a withdrawal that
// takes nothing away, and an identity that hashes two different behaviors to one agent id.
// A module written inline inside `createAgent` has no `requires` to read, and the tuple's own
// element constraint is its contextual type, so inference falls back to the constraint rather than
// to the empty default. Reading that as "requires every service" rejected a module that requires
// none, which is the shape a one-off module is most naturally written in.
describe("a module written inline", () => {
  test("composes with no requires declared", () => {
    const agent = createAgent({
      modules: [defineModule({ id: "inline", setup: () => ({ events: ["Noted"] }) })]
    })
    expect(agent.definition.events).toEqual(["Noted"])
  })

  test("still reports a requirement no module provides", () => {
    const consumer = defineModule({
      id: "consumer",
      requires: [InferenceStateProjection] as const,
      setup: () => ({})
    })
    // @ts-expect-error the tuple provides no InferenceStateProjection
    expect(() => createAgent({ modules: [consumer] })).toThrow(
      'module "consumer" requires missing service "flamecast/InferenceStateProjection"'
    )
  })
})

describe("composition checks", () => {
  const bare = (part: Record<string, unknown>) =>
    defineModule({ id: "generated", setup: () => part as never })

  test("a transition on an event no module declares is rejected", () => {
    expect(() =>
      createAgent({
        modules: [
          bare({
            events: ["Started"],
            machines: [machine({ id: "m", initial: "idle", states: { idle: { on: { Startd: "go" } }, go: {} } })]
          })
        ]
      })
    ).toThrow('machine "m" transitions on "Startd" in state "idle", which no module declares')
  })

  test("an event a module declares and no machine reads is ordinary", () => {
    const agent = createAgent({
      modules: [bare({ events: ["Noted"], machines: [] })]
    })
    expect(agent.definition.events).toEqual(["Noted"])
  })

  test("a withdrawal that names no offered tool is rejected", () => {
    expect(() =>
      createAgent({
        modules: [
          bare({
            nativeTools: [{ name: "lookup_invoice", description: "d", inputSchema: {} }],
            nudges: [
              { id: "n", when: () => true, text: "t", withdrawsNativeTools: ["lookup_invoce"] }
            ]
          })
        ]
      })
    ).toThrow('nudge "n" withdraws "lookup_invoce", which no module offers')
  })

  test("withdrawing everything names no tool, so it is always allowed", () => {
    const agent = createAgent({
      modules: [
        bare({
          nativeTools: [{ name: "lookup", description: "d", inputSchema: {} }],
          nudges: [{ id: "n", when: () => true, text: "t", withdrawsNativeTools: [WITHDRAW_ALL] }]
        })
      ]
    })
    expect(agent.definition.render.nudges).toHaveLength(1)
  })

  // The agent id hashes identity, and the hash writes any function as one constant, so two modules
  // whose behavior differs only inside a function would share an id and a rollout would reuse the
  // wrong recording.
  test("a function carried in identity is rejected", () => {
    expect(() =>
      createAgent({
        modules: [
          defineModule({ id: "picky", identity: { pick: (log: unknown) => log }, setup: () => ({}) })
        ]
      })
    ).toThrow('module "picky" carries a function at identity pick')
  })

  test("a function nested deeper in identity is found too", () => {
    expect(() =>
      createAgent({
        modules: [
          defineModule({ id: "deep", identity: { a: { b: { c: () => 1 } } }, setup: () => ({}) })
        ]
      })
    ).toThrow('module "deep" carries a function at identity a.b.c')
  })
})

describe("the declared alphabet", () => {
  test("gathers every module's events into one sorted list", () => {
    const agent = createAgent({ modules: defaultPack({ nativeTools: [lookupInvoice] }) })
    expect(agent.definition.events).toEqual([...new Set(agent.definition.events)].sort())
    expect(agent.definition.events).toContain("MessageReceived")
    expect(agent.definition.events).toContain("ToolReturned")
    expect(agent.definition.events).toContain("BudgetRequested")
    expect(agent.definition.events).toContain("AnswerRejected")
    expect(agent.definition.events).toContain("CompactionCompleted")
  })

  test("names an event type no module declared", () => {
    const agent = createAgent({ modules: [inference()] })
    expect(
      undeclaredEvents(agent.definition, [
        { type: "MessageReceived", id: "m-1" },
        { type: "ModelCalled", turn: "m-1" },
        // The model loop emits this one and waits on its result, so an inference-only agent
        // declares both halves even though nothing dispatches the call.
        { type: "ToolCalled", turn: "m-1" },
        { type: "ToolReturned", turn: "m-1" },
        { type: "HandoffAccepted", turn: "m-1" }
      ])
    ).toEqual(["HandoffAccepted"])
  })

  test("declares nothing the empty agent can meet", () => {
    const agent = createAgent({ modules: [] })
    expect(agent.definition.events).toEqual([])
    expect(undeclaredEvents(agent.definition, [{ type: "MessageReceived" }])).toEqual([
      "MessageReceived"
    ])
  })
})

describe("composition", () => {
  test("keeps configuration with the module that owns it", () => {
    const agent = createAgent({
      modules: defaultPack({
        inference: {
          system: "You are a support agent.",
          messageTruncateAt: 900
        },
        nativeTools: [lookupInvoice],
        budget: { defaultBudget: 24 }
      })
    })
    expect(agent.request([]).system).toBe("You are a support agent.")
    expect(agent.definition.render.messageTruncateAt).toBe(900)
    expect(agent.definition.render.nativeTools.map((tool) => tool.name)).toEqual(["lookup_invoice"])
    expect(agent.definition.modules.find((module) => module.id === "budget")?.identity).toMatchObject({
      defaultBudget: 24
    })
  })

  test("passes the complete render plan to machine builders", () => {
    const seen: Array<number> = []
    const probe = defineModule({
      id: "probe",
      setup: () => ({
        machines: (render) => {
          seen.push(render.messageTruncateAt)
          return []
        }
      })
    })
    createAgent({ modules: [inference({ messageTruncateAt: 777 }), probe] })
    expect(seen).toEqual([777])
  })

  test("rejects duplicate module ids at runtime", () => {
    expect(() =>
      createAgent({ modules: [nativeTools([]), nativeTools([])] } as never)
    ).toThrow('duplicate module id "native-tools"')
  })

  test("rejects duplicate native tool names at runtime", () => {
    const duplicate = { ...lookupInvoice }
    expect(() =>
      createAgent({ modules: [nativeTools([lookupInvoice, duplicate])] })
    ).toThrow('duplicate native tool name "lookup_invoice"')
  })

  test("rejects duplicate service providers at runtime", () => {
    class ValueProjection extends Context.Service<
      ValueProjection,
      Projection<number>
    >()("test/ValueProjection") {}
    const one = defineModule({
      id: "one",
      services: Context.make(ValueProjection, () => 1),
      setup: () => ({})
    })
    const two = defineModule({
      id: "two",
      services: Context.make(ValueProjection, () => 2),
      setup: () => ({})
    })
    expect(() => createAgent({ modules: [one, two] } as never)).toThrow(
      'service "test/ValueProjection" is provided by more than one module'
    )
  })
})

describe("typed module dependencies", () => {
  test("injects a projection provided by another module", () => {
    class CountProjection extends Context.Service<
      CountProjection,
      Projection<number>
    >()("test/CountProjection") {}
    const source = defineModule({
      id: "source",
      services: Context.make(CountProjection, (log) => log.length),
      setup: () => ({})
    })
    const seen: Array<number> = []
    const consumer = defineModule({
      id: "consumer",
      requires: [CountProjection] as const,
      setup: (services) => {
        const count = Context.get(services, CountProjection)
        return {
          nudges: [
            {
              id: "count",
              when: (log) => {
                seen.push(count(log))
                return false
              },
              text: "unused"
            }
          ]
        }
      }
    })
    const agent = createAgent({ modules: [source, consumer] })
    const log: ReadonlyArray<Event> = [{ type: "Observed" }]
    agent.request(log)
    expect(Context.get(agent.services, CountProjection)(log)).toBe(1)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((value) => value === 1)).toBe(true)
  })

  test("tracks a model selection whose context window changes", () => {
    const small = customInference(async () => ({ kind: "complete", output: "small" }), {
      id: "small",
      model: "small",
      contextWindow: 16_000
    })
    const large = customInference(async () => ({ kind: "complete", output: "large" }), {
      id: "large",
      model: "large",
      contextWindow: 200_000
    })
    const agent = createAgent({
      modules: [
        inference({ provider: (log) => (log.some((event) => event.type === "UseLarge") ? large : small) }),
        morphCompaction()
      ]
    })
    const state = Context.get(agent.services, InferenceStateProjection)
    expect(state([]).contextWindow).toBe(16_000)
    expect(state([{ type: "UseLarge" }]).contextWindow).toBe(200_000)
  })

  test("rejects missing service dependencies in generated JavaScript", () => {
    expect(() => createAgent({ modules: [morphCompaction()] } as never)).toThrow(
      'module "compaction" requires missing service "flamecast/InferenceStateProjection"'
    )
  })

  const compileTimeChecks = () => {
    class DuplicateProjection extends Context.Service<
      DuplicateProjection,
      Projection<number>
    >()("test/DuplicateProjection") {}
    const first = defineModule({
      id: "first",
      services: Context.make(DuplicateProjection, () => 1),
      setup: () => ({})
    })
    const second = defineModule({
      id: "second",
      services: Context.make(DuplicateProjection, () => 2),
      setup: () => ({})
    })
    // @ts-expect-error compaction requires InferenceStateProjection
    createAgent({ modules: [morphCompaction()] })
    // @ts-expect-error module ids must be unique
    createAgent({ modules: [nativeTools([]), nativeTools([])] })
    // @ts-expect-error service providers must be unique
    createAgent({ modules: [first, second] })
  }

  test("keeps invalid tuples out of callable code", () => {
    expect(compileTimeChecks).toBeFunction()
  })
})

describe("program identity", () => {
  test("is stable across two builds of the same modules", () => {
    const one = createAgent({ modules: defaultPack() })
    const two = createAgent({ modules: defaultPack() })
    expect(one.definition.id).toBe(two.definition.id)
    expect(one.definition.id).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  test("changes when module order changes", () => {
    const one = createAgent({ modules: [inference(), nativeTools([])] })
    const two = createAgent({ modules: [nativeTools([]), inference()] })
    expect(one.definition.id).not.toBe(two.definition.id)
  })

  test("changes when module-owned prompt configuration changes", () => {
    const one = createAgent({ modules: [inference()] })
    const two = createAgent({ modules: [inference({ system: "Be terse." })] })
    expect(one.definition.id).not.toBe(two.definition.id)
  })

  test("changes when native tool code configuration changes", () => {
    const one = createAgent({ modules: [nativeTools([lookupInvoice])] })
    const two = createAgent({
      modules: [
        nativeTools([{ ...lookupInvoice, spec: { ...lookupInvoice.spec, description: "Other." } }])
      ]
    })
    expect(one.definition.id).not.toBe(two.definition.id)
  })

  test("records an explicit lineage without changing its parent", () => {
    const parent = createAgent({ modules: [inference()] })
    const child = createAgent({
      parent: parent.definition.id,
      modules: [inference({ system: "Be terse." })]
    })
    expect(child.definition.parent).toBe(parent.definition.id)
    expect(parent.definition.parent).toBeUndefined()
  })

  test("accepts a source-controlled identity for code-first candidates", () => {
    const agent = createAgent({ id: "git:abc123", modules: [inference()] })
    expect(agent.definition.id).toBe("git:abc123")
  })
})
