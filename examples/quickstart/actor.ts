import { Effect, Schema } from "effect"
import { Rpc } from "effect/unstable/rpc"
import { atom, defineActor } from "tardie/core"
import { agentMethods, compact, infer, messages, tools as libraryTools } from "tardie/agent"
import { defineLibrary, MethodDescription, MethodHints } from "tardie/libraries"

const actorName = "weather-agent"

const actorInstructions = `
Answer questions about the weather.
Use the weather tool for current conditions.
`.trim()

export const weather = defineLibrary({
  name: "weather",
  description: "Weather information",
  toolNames: { current: "get_weather" },
  methods: [Rpc.make("current", {
    payload: Schema.Struct({ city: Schema.String }),
    success: Schema.Struct({ city: Schema.String, temperature: Schema.Finite }),
  })
    .annotate(MethodDescription, "Get example weather data for a city")
    .annotate(MethodHints, { readOnlyHint: true, openWorldHint: false })],
})

export default defineActor(actorName, Effect.gen(function* () {
  const system = atom(actorInstructions)
  const tools = yield* libraryTools([weather])
  const context = yield* compact(messages)
  const agent = yield* infer(atom(get => ({
    system: get(system),
    tools: get(tools),
    context: get(context),
  })))
  return { atom: agent, methods: agentMethods }
}))
