import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { createActor } from "@clavia/tardigrade-agent"
import { ModelInfo, ToolCatalog } from "@clavia/tardigrade-agent/actor/context"
import { Generate, Summarize, ExecuteTool, AskPermission } from "@clavia/tardigrade-agent/contracts/acts"
import { requestTurn, type Event as AgentEvent } from "@clavia/tardigrade-agent/contracts/events"
import { createTestStore } from "../properties/runtime/store"

const model = { provider: "openrouter" as const, model_id: "test" }
const continuation = { provider: "openrouter", protocol: "openrouter-chat-completions", model: "test", payload: { encrypted: "c".repeat(400) } }

test("summary body omits provider continuations", async () => {
  const bodies: string[] = []
  const history: AgentEvent[] = [
    { type: "TurnRequested", turnId: "previous", text: "x".repeat(500) },
    { type: "ModelCalled", purpose: "inference", turnId: "previous", callId: "model:previous:0", model, contextWindowTokens: 256 },
    { type: "ModelReturned", purpose: "inference", callId: "model:previous:0", text: "visible answer", reasoning: "visible reasoning", continuation, toolCalls: [] },
    { type: "TurnSettled", turnId: "previous", outcome: "completed", callId: "model:previous:0" },
  ]
  await Effect.runPromise(Effect.gen(function* () {
    const store = yield* createTestStore({ actor: createActor, events: history, actorContext: Context.pick(ModelInfo, ToolCatalog), services: () => Layer.mergeAll(
      Layer.succeed(ModelInfo, { model, contextWindowTokens: 256 }), Layer.succeed(ToolCatalog, { names: [], specs: [] }),
      Generate.layer(() => Effect.succeed({ text: "done", toolCalls: [] })),
      Summarize.layer(input => Effect.sync(() => {
        bodies.push(JSON.stringify(input.context))
        return { text: "summary", toolCalls: [] }
      })),
      ExecuteTool.layer(() => Effect.succeed(null)), AskPermission.layer(() => Effect.succeed({ allowed: true, reason: "allowed" })),
    ) })
    yield* store.send([requestTurn({ text: "next", turnId: "next", invocationRef: { method: "turn", id: "next" } })])
    yield* store.wait
    yield* store.close
  }).pipe(Effect.scoped, Effect.timeout(5_000)))
  expect(bodies).toHaveLength(1)
  expect(bodies[0]).toContain("visible answer")
  expect(bodies[0]).toContain("visible reasoning")
  expect(bodies[0]).not.toContain("continuation")
})
