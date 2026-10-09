import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { Promises } from "@clavia/tardigrade-core"
import { createActor } from "@clavia/tardigrade-agent"
import { ModelInfo, ToolCatalog } from "@clavia/tardigrade-agent/actor/context"
import { Generate, Summarize, ExecuteTool, AskPermission } from "@clavia/tardigrade-agent/contracts/acts"
import { requestTurn, type Event as AgentEvent } from "@clavia/tardigrade-agent/contracts/events"
import { createTestStore } from "../properties/runtime/store"

const model = { provider: "openrouter" as const, model_id: "test" }
const answer = "a".repeat(2_000)
const continuation = { provider: "openrouter", protocol: "openrouter-chat-completions", model: "test", payload: { content: [{ role: "assistant", content: [{ type: "text", text: answer }] }] } }

const summaries = (reply: Extract<AgentEvent, { type: "ModelReturned" }>) => Effect.runPromise(Effect.gen(function* () {
  let count = 0
  const history: AgentEvent[] = [
    { type: "TurnRequested", turnId: "previous", text: "hello" },
    { type: "ModelCalled", purpose: "inference", turnId: "previous", callId: "model:previous:0", model, contextWindowTokens: 1_000 },
    reply,
    { type: "TurnSettled", turnId: "previous", outcome: "completed", callId: "model:previous:0" },
  ]
  const store = yield* createTestStore({ actor: createActor, events: history, actorContext: Context.pick(ModelInfo, ToolCatalog), services: () => Layer.mergeAll(
    Layer.succeed(ModelInfo, { model, contextWindowTokens: 1_000 }), Layer.succeed(ToolCatalog, { names: [], specs: [] }),
    Generate.layer(() => Effect.succeed({ text: "done", toolCalls: [] })),
    Summarize.layer(() => Effect.sync(() => { count++; return { text: "summary", toolCalls: [] } })),
    ExecuteTool.layer(() => Effect.succeed(null)), AskPermission.layer(() => Effect.succeed({ allowed: true, reason: "allowed" })),
    Layer.succeed(Promises, { watch: () => Effect.void, cancel: () => Effect.void }),
  ) })
  yield* store.send([requestTurn({ text: "next", turnId: "next", invocationRef: { method: "turn", id: "next" } })])
  yield* store.wait
  yield* store.close
  return count
}).pipe(Effect.scoped, Effect.timeout(5_000)))

test("estimate counts a continuation in place of the text it replays", async () => {
  const base = { type: "ModelReturned", purpose: "inference", callId: "model:previous:0", text: answer, toolCalls: [] } as const
  expect(await summaries(base)).toBe(0)
  expect(await summaries({ ...base, continuation })).toBe(0)
})
