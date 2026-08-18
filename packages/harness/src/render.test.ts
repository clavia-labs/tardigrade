import { describe, expect, test } from "bun:test"
import type { Event } from "@flamecast/core"
import type { NativeToolSpec } from "./infer"
import type { AgentDefinition, Nudge, RenderPlan } from "./definition"
import { WITHDRAW_ALL } from "./definition"
import { modelRequest, nativeToolSurface, renderMessages, systemPrompt } from "./render"

const lookup: NativeToolSpec = { name: "lookup_invoice", description: "Look one up.", inputSchema: {} }
const notify: NativeToolSpec = { name: "notify", description: "Tell someone.", inputSchema: {} }

// The base plan carries no truncation bound, which is what `createAgent` compiles until a module
// asks for one.
const renderOf = (over: Partial<RenderPlan> = {}): RenderPlan => ({
  instructions: [{ id: "base", text: "You are a support agent." }],
  nativeTools: [lookup, notify],
  nudges: [],
  ...over
})

const programOf = (render: RenderPlan): Pick<AgentDefinition<never>, "render"> => ({ render })

const usedLookup = (log: ReadonlyArray<Event>): boolean =>
  log.some((event) => event.type === "ToolReturned" && event.name === "lookup_invoice")

const citeInvoice: Nudge = {
  id: "cite-invoice",
  when: usedLookup,
  text: "You read an invoice this turn. Name the invoice id in your answer."
}

const head: Event = { type: "MessageReceived", id: "m-1", text: "Find order 4182.", at: 1 }
const returned: Event = {
  type: "ToolReturned",
  turn: "m-1",
  callId: "c-1",
  name: "lookup_invoice",
  result: { invoice: "INV-4182" },
  at: 2
}

describe("nudges", () => {
  test("keeps dynamic nudges out of the static system prefix by default", () => {
    const render = renderOf({ nudges: [citeInvoice] })
    expect(systemPrompt(render, [head])).toBe("You are a support agent.")
    expect(systemPrompt(render, [head, returned])).toBe("You are a support agent.")
    expect(modelRequest(programOf(render), [head, returned]).messages.at(-1)).toEqual({
      role: "system",
      content: citeInvoice.text
    })
  })

  test("allows an explicit system-placement nudge", () => {
    const render = renderOf({ nudges: [{ ...citeInvoice, placement: "system" }] })
    expect(systemPrompt(render, [head, returned])).toBe(
      `You are a support agent.\n\n${citeInvoice.text}`
    )
    expect(modelRequest(programOf(render), [head, returned]).messages.at(-1)).not.toEqual({
      role: "system",
      content: citeInvoice.text
    })
  })

  test("withdraws one tool from the surface", () => {
    const wall: Nudge = {
      id: "budget-wall",
      when: usedLookup,
      text: "Budget spent.",
      withdrawsNativeTools: ["lookup_invoice"]
    }
    const render = renderOf({ nudges: [wall] })
    expect(nativeToolSurface(render, [head]).map((tool) => tool.name)).toEqual([
      "lookup_invoice",
      "notify"
    ])
    expect(nativeToolSurface(render, [head, returned]).map((tool) => tool.name)).toEqual(["notify"])
  })

  test("the wildcard closes base native tools and leaves nudge native tools", () => {
    const answer: NativeToolSpec = { name: "answer", description: "Finish.", inputSchema: {} }
    const render = renderOf({
      nudges: [
        {
          id: "budget-wall",
          when: usedLookup,
          text: "Spent.",
          withdrawsNativeTools: [WITHDRAW_ALL]
        },
        { id: "answer", when: () => true, text: "Answer.", nativeTools: [answer] }
      ]
    })
    expect(nativeToolSurface(render, [head]).map((tool) => tool.name)).toEqual([
      "lookup_invoice",
      "notify",
      "answer"
    ])
    expect(nativeToolSurface(render, [head, returned]).map((tool) => tool.name)).toEqual(["answer"])
  })

  test("can derive a tool schema from the log", () => {
    const render = renderOf({
      nativeTools: [],
      nudges: [
        {
          id: "answer",
          when: (log) => log.some((event) => event.output !== undefined),
          text: "Answer.",
          nativeTools: (log) => [
            {
              name: "answer",
              description: "Finish.",
              inputSchema: log.find((event) => event.output !== undefined)?.output
            }
          ]
        }
      ]
    })
    const declared: Event = { ...head, output: { type: "object" } }
    expect(nativeToolSurface(render, [head])).toEqual([])
    expect(nativeToolSurface(render, [declared])[0]?.inputSchema).toEqual({ type: "object" })
  })

  test("rejects duplicate tools that become active together", () => {
    const render = renderOf({
      nudges: [
        {
          id: "duplicate",
          when: () => true,
          text: "Duplicate.",
          nativeTools: [lookup]
        }
      ]
    })
    expect(() => nativeToolSurface(render, [head])).toThrow(
      'duplicate active native tool name "lookup_invoice"'
    )
  })
})

describe("module-owned native tool descriptions", () => {
  test("renders the description supplied by the tool module", () => {
    expect(nativeToolSurface(renderOf(), [head])[0]?.description).toBe("Look one up.")
    expect(nativeToolSurface(renderOf(), [head])[1]?.description).toBe("Tell someone.")
  })
})

describe("truncation", () => {
  test("honors messageTruncateAt", () => {
    const render = renderOf({ messageTruncateAt: 10 })
    const long: Event = { type: "MessageReceived", id: "m-1", text: "x".repeat(40), at: 1 }
    expect(renderMessages(render, [long])[0]?.content).toBe(
      `${"x".repeat(10)}…[truncated 40 chars]`
    )
  })

  test("honors resultTruncateAt", () => {
    const render = renderOf({ resultTruncateAt: 12 })
    const big: Event = { ...returned, result: { body: "y".repeat(40) } }
    expect(renderMessages(render, [big])[0]?.content).toBe(`{"body":"yyy…[truncated 51 chars]`)
  })

  test("leaves a short message alone", () => {
    expect(renderMessages(renderOf(), [head])[0]?.content).toBe("Find order 4182.")
  })

  // The defect this guards: a bound nobody asked for cut a long message down on the way to the
  // model while the log kept the whole thing, so the record and the request disagreed and only the
  // request is what the model answered.
  test("sends a message whole when no module bounds it", () => {
    const render = renderOf()
    const long: Event = { type: "MessageReceived", id: "m-1", text: "x".repeat(500_000), at: 1 }
    const big: Event = { ...returned, result: { body: "y".repeat(500_000) } }
    expect(renderMessages(render, [long])[0]?.content).toBe("x".repeat(500_000))
    expect(String(renderMessages(render, [big])[0]?.content)).toContain("y".repeat(500_000))
  })
})

describe("modelRequest", () => {
  test("is a pure function of the program and log", () => {
    const program = programOf(renderOf({ nudges: [citeInvoice] }))
    const log = [head, returned]
    expect(modelRequest(program, log)).toEqual(modelRequest(program, log))
  })

  test("rebuilds the conversation from the record", () => {
    const log: ReadonlyArray<Event> = [
      head,
      { type: "ModelCalled", turn: "m-1", callId: "k-0", at: 2 },
      { type: "TextReturned", turn: "m-1", text: "Looking it up.", at: 3 },
      {
        type: "ToolCalled",
        turn: "m-1",
        callId: "c-1",
        name: "lookup_invoice",
        arguments: { orderId: "4182" },
        at: 4
      },
      returned,
      { type: "TurnCompleted", turn: "m-1", output: "INV-4182.", at: 5 }
    ]
    expect(modelRequest(programOf(renderOf()), log).messages).toEqual([
      { role: "user", content: "Find order 4182." },
      {
        role: "assistant",
        content: "Looking it up.",
        toolCalls: [{ id: "c-1", name: "lookup_invoice", arguments: '{"orderId":"4182"}' }]
      },
      {
        role: "tool",
        toolCallId: "c-1",
        toolName: "lookup_invoice",
        content: '{"invoice":"INV-4182"}'
      },
      { role: "assistant", content: "INV-4182." }
    ])
  })

  test("renders from the checkpoint summary and live suffix", () => {
    const log: ReadonlyArray<Event> = [
      head,
      { type: "TurnCompleted", turn: "m-1", output: "old", at: 2 },
      { type: "CompactionCompleted", upTo: 2, summary: "Order 4182 was discussed.", at: 3 },
      { type: "MessageReceived", id: "m-2", text: "And the refund?", at: 4 }
    ]
    expect(modelRequest(programOf(renderOf()), log).messages).toEqual([
      { role: "user", content: "Summary of earlier work:\nOrder 4182 was discussed." },
      { role: "user", content: "And the refund?" }
    ])
  })

  test("survives an event type it never met", () => {
    const log = [head, { type: "SomethingNew", turn: "m-1", at: 9 }, returned]
    expect(modelRequest(programOf(renderOf()), log).messages).toHaveLength(2)
  })
})
