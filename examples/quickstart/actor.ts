import { Effect } from "effect"
import { actor } from "tardie/core"
import { agentMessageMethod, infer, nativeOutput, system, tool } from "tardie/agent"

const actorName = "weather-agent"

const actorInstructions = `
Answer questions about the weather.
Use the weather tool for current conditions.
`.trim()

const weather = tool({
  spec: {
    name: "get_weather",
    description: "Get the current weather for a city",
    inputSchema: { type: "object" }
  },
  run: () => Effect.succeed({ temperature: 21 })
})

export default actor({
  name: actorName,
  methods: { message: agentMessageMethod },
  components: [infer([
    system(actorInstructions),
    weather,
    nativeOutput
  ])]
})
