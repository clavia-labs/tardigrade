import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Envelope } from "@flamecast/core"
import { customInference, type Tool } from "./infer"
import { createAgent, defineModule, undeclaredEvents } from "./module"
import { morphCompaction } from "./modules/compaction"
import { inference, inferenceState } from "./modules/inference"
import { tools } from "./modules/tools"
import { defaultPack } from "./pack"
import { announce, signal } from "./signal"

const lookupInvoice: Tool = {
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

describe("the declared alphabet", () => {
  test("gathers every module's events into one sorted list", () => {
    const agent = createAgent({ modules: defaultPack({ tools: [lookupInvoice] }) })
    expect(agent.program.events).toEqual([...new Set(agent.program.events)].sort())
    expect(agent.program.events).toContain("MessageReceived")
    expect(agent.program.events).toContain("ToolReturned")
    expect(agent.program.events).toContain("BudgetRequested")
    expect(agent.program.events).toContain("AnswerRejected")
    expect(agent.program.events).toContain("CompactionCompleted")
  })

  test("names an event type no module declared", () => {
    const agent = createAgent({ modules: [inference()] })
    expect(
      undeclaredEvents(agent.program, [
        { type: "MessageReceived", id: "m-1" },
        { type: "ModelCalled", turn: "m-1" },
        { type: "ToolReturned", turn: "m-1" },
        { type: "HandoffAccepted", turn: "m-1" }
      ])
    ).toEqual(["HandoffAccepted", "ToolReturned"])
  })

  test("declares nothing the empty agent can meet", () => {
    const agent = createAgent({ modules: [] })
    expect(agent.program.events).toEqual([])
    expect(undeclaredEvents(agent.program, [{ type: "MessageReceived" }])).toEqual([
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
        tools: [lookupInvoice],
        budget: { defaultBudget: 24 }
      })
    })
    expect(agent.request([]).system).toBe("You are a support agent.")
    expect(agent.program.render.messageTruncateAt).toBe(900)
    expect(agent.program.render.tools.map((tool) => tool.name)).toEqual(["lookup_invoice"])
    expect(agent.program.modules.find((module) => module.id === "budget")?.fingerprint).toMatchObject({
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
      createAgent({ modules: [tools([]), tools([])] } as never)
    ).toThrow('duplicate module id "tools"')
  })

  test("rejects duplicate tool names at runtime", () => {
    const duplicate = { ...lookupInvoice }
    expect(() =>
      createAgent({ modules: [tools([lookupInvoice, duplicate])] })
    ).toThrow('duplicate tool name "lookup_invoice"')
  })

  test("rejects duplicate signal owners at runtime", () => {
    const value = signal<"test.value", number>("test.value")
    const one = defineModule({
      id: "one",
      provides: [announce(value, () => 1)] as const,
      setup: () => ({})
    })
    const two = defineModule({
      id: "two",
      provides: [announce(value, () => 2)] as const,
      setup: () => ({})
    })
    expect(() => createAgent({ modules: [one, two] } as never)).toThrow(
      'signal "test.value" is announced by more than one module'
    )
  })
})

describe("typed module signals", () => {
  test("lets a consumer read state announced by another module", () => {
    const count = signal<"test.count", number>("test.count")
    const source = defineModule({
      id: "source",
      provides: [announce(count, (log) => log.length)] as const,
      setup: () => ({})
    })
    const seen: Array<number> = []
    const consumer = defineModule({
      id: "consumer",
      requires: [count] as const,
      setup: (context) => ({
        nudges: [
          {
            id: "count",
            when: (log) => {
              seen.push(context.read(count, log))
              return false
            },
            text: "unused"
          }
        ]
      })
    })
    const agent = createAgent({ modules: [source, consumer] })
    const log: ReadonlyArray<Envelope> = [{ type: "Observed" }]
    agent.request(log)
    expect(agent.read(count, log)).toBe(1)
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
    expect(agent.read(inferenceState, []).contextWindow).toBe(16_000)
    expect(agent.read(inferenceState, [{ type: "UseLarge" }]).contextWindow).toBe(200_000)
  })

  test("rejects missing signal dependencies in generated JavaScript", () => {
    expect(() => createAgent({ modules: [morphCompaction()] } as never)).toThrow(
      'module "compaction" requires missing signal "inference.state"'
    )
  })

  const compileTimeChecks = () => {
    // @ts-expect-error compaction requires inference.state
    createAgent({ modules: [morphCompaction()] })
    // @ts-expect-error module ids must be unique
    createAgent({ modules: [tools([]), tools([])] })
  }

  test("keeps invalid tuples out of callable code", () => {
    expect(compileTimeChecks).toBeFunction()
  })
})

describe("program identity", () => {
  test("is stable across two builds of the same modules", () => {
    const one = createAgent({ modules: defaultPack() })
    const two = createAgent({ modules: defaultPack() })
    expect(one.program.id).toBe(two.program.id)
    expect(one.program.id).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  test("changes when module order changes", () => {
    const one = createAgent({ modules: [inference(), tools([])] })
    const two = createAgent({ modules: [tools([]), inference()] })
    expect(one.program.id).not.toBe(two.program.id)
  })

  test("changes when module-owned prompt configuration changes", () => {
    const one = createAgent({ modules: [inference()] })
    const two = createAgent({ modules: [inference({ system: "Be terse." })] })
    expect(one.program.id).not.toBe(two.program.id)
  })

  test("changes when tool code configuration changes", () => {
    const one = createAgent({ modules: [tools([lookupInvoice])] })
    const two = createAgent({
      modules: [
        tools([{ ...lookupInvoice, spec: { ...lookupInvoice.spec, description: "Other." } }])
      ]
    })
    expect(one.program.id).not.toBe(two.program.id)
  })

  test("records an explicit lineage without changing its parent", () => {
    const parent = createAgent({ modules: [inference()] })
    const child = createAgent({
      parent: parent.program.id,
      modules: [inference({ system: "Be terse." })]
    })
    expect(child.program.parent).toBe(parent.program.id)
    expect(parent.program.parent).toBeUndefined()
  })

  test("accepts a source-controlled identity for code-first candidates", () => {
    const agent = createAgent({ id: "git:abc123", modules: [inference()] })
    expect(agent.program.id).toBe("git:abc123")
  })
})
