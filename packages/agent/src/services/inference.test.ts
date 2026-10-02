import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { RuntimeError, atom, createActorStore, defineActor, type ActorRuntime, type CoreEvent } from "@clavia/tardigrade-core"
import { ModelInfo } from "../actor/context"
import { Generate, Summarize } from "../contracts/acts"
import { Event, type Conversation } from "../contracts/events"
import { messages } from "../atoms/durable/trajectory"
import { infer } from "../atoms/infer"

for (const reopen of [false, true]) {
  test(`inference records reasoning before tool results (reopen: ${reopen})`, () => Effect.runPromise(Effect.gen(function* () {
    const continuation = { provider: "openai", protocol: "openai-responses", model: "fixture", payload: { content: [{ role: "assistant", content: [{ type: "reasoning", text: "", options: { openai: { encryptedContent: "opaque" } } }] }] } }
    const actor = defineActor("reasoning", Effect.gen(function* () {
      const node = yield* infer<never>(atom(get => ({ system: "", tools: { view: { specs: [] }, events: {}, acts: {} }, context: { view: { position: "ready" as const, messages: get(messages) }, events: {}, acts: {} } })))
      return { atom: node, schema: Event }
    }))
    const inputs: (typeof Conversation.Type)[] = []
    let runtime!: ActorRuntime<Event>
    const open = (events?: readonly (Event | CoreEvent)[]) => createActorStore({ actor, ...(events ? { events } : {}),
      actorContext: Context.pick(ModelInfo),
      services: current => {
        runtime = current
        return Layer.mergeAll(Layer.succeed(ModelInfo, { model: { provider: "openai", model_id: "fixture" }, contextWindowTokens: 10000 }), Summarize.layer(() => Effect.succeed({ text: "summary", toolCalls: [] })), Generate.layer(input => Effect.sync(() => {
          inputs.push(input.context)
          return inputs.length === 1
            ? { text: "working", reasoning: "Check", continuation, toolCalls: [{ callId: "provider-call", name: "read", input: {} }] }
            : { text: "done", toolCalls: [] }
        })))
      },
    })
    let store = yield* open()
    yield* Effect.gen(function* () {
      yield* runtime.send([{ type: "TurnRequested", turnId: "turn", text: "Read" }])
      yield* store.wait
      const returned = store.snapshot().events.find(event => event.type === "ModelReturned" && event.purpose === "inference")
      expect(returned).toMatchObject({ reasoning: "Check", continuation })
      if (!returned || returned.type !== "ModelReturned" || returned.purpose !== "inference") throw new RuntimeError("Missing model response")
      const call = returned.toolCalls[0]!
      if (reopen) {
        const history = JSON.parse(JSON.stringify(store.snapshot().events)) as readonly (Event | CoreEvent)[]
        yield* store.close
        store = yield* open(history)
      }
      yield* runtime.send([{ type: "ToolReturned", callId: call.callId, output: "contents", error: null }])
      yield* store.wait
      expect(inputs).toHaveLength(2)
      expect(inputs[1]?.find(message => message.role === "assistant")).toMatchObject({ reasoning: "Check", continuation })
      expect(inputs[1]?.find(message => message.role === "tool")).toMatchObject({ providerId: "provider-call", text: "contents" })
      expect(store.snapshot().events.filter(event => event.type === "ModelReturned")).toHaveLength(2)
      expect(store.snapshot().events.filter(event => event.type === "TurnSettled")).toMatchObject([{ outcome: "completed" }])
    }).pipe(Effect.ensuring(Effect.suspend(() => store.close)))
  }).pipe(Effect.scoped, Effect.timeout(5000))))
}
