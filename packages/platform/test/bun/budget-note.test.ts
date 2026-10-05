import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { Promises } from "@clavia/tardigrade-core"
import { createActor } from "@clavia/tardigrade-agent"
import { ModelInfo, ToolCatalog } from "@clavia/tardigrade-agent/actor/context"
import { Generate, Summarize, ExecuteTool, AskPermission } from "@clavia/tardigrade-agent/contracts/acts"
import { requestTurn, type Event as AgentEvent } from "@clavia/tardigrade-agent/contracts/events"
import { createTestStore } from "../properties/runtime/store"

test("tool budget leaves the system prompt stable across a turn's model calls", async () => {
  const requests: { system: string; last: string }[] = []
  const history: AgentEvent[] = [{ type: "BudgetConfigured", metric: "toolCalls", policy: { limit: 5 } }]
  await Effect.runPromise(Effect.gen(function* () {
    const store = yield* createTestStore({ actor: createActor, events: history, actorContext: Context.pick(ModelInfo, ToolCatalog), services: () => Layer.mergeAll(
      Layer.succeed(ModelInfo, { model: { provider: "openrouter", model_id: "test" }, contextWindowTokens: 100_000 }),
      Layer.succeed(ToolCatalog, { names: ["test.job"], specs: [] }),
      Generate.layer(input => Effect.sync(() => {
        const last = input.context.at(-1)
        requests.push({ system: input.system, last: last && "text" in last ? last.text : "" })
        return requests.length === 1 ? { text: "", toolCalls: [{ callId: "tool:0", name: "test.job", input: {} }] } : { text: "done", toolCalls: [] }
      })),
      Summarize.layer(() => Effect.succeed({ text: "summary", toolCalls: [] })),
      ExecuteTool.layer(() => Effect.succeed(null)), AskPermission.layer(() => Effect.succeed({ allowed: true, reason: "allowed" })),
      Layer.succeed(Promises, { watch: () => Effect.void, cancel: () => Effect.void }),
    ) })
    yield* store.send([requestTurn({ text: "go", turnId: "first", invocationRef: { method: "turn", id: "first" } })])
    yield* store.wait
    yield* store.close
  }).pipe(Effect.scoped, Effect.timeout(5_000)))
  expect(requests).toHaveLength(2)
  expect(requests[1]!.system).toBe(requests[0]!.system)
  expect(requests[0]!.system).not.toContain("Tool calls remaining")
  expect(requests[0]!.last).toBe("Tool calls remaining: 5/5.")
  expect(requests[1]!.last).toBe("Tool calls remaining: 4/5.")
})
