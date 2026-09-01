import type { AgentComponent, AgentTool } from "tardie"
import { actor, agentMessageMethod, infer, nativeOutput, system } from "tardie"

const actorName = "weather-agent"

const actorInstructions = `
Answer questions about the weather.
Use the weather tool for current conditions.
`.trim()

const serveWeather: AgentTool["serve"] = (call, _log, answer) => {
  const city = typeof call.arguments === "object" && call.arguments !== null && "city" in call.arguments
    ? String(call.arguments.city)
    : "unknown"
  return [answer({ city, temperature: 21, unit: "celsius" })]
}

const weather: AgentComponent = {
  name: "weather",
  derive: () => ({
    view: {
      system: [],
      tools: [{
        spec: {
          name: "get_weather",
          description: "Get the current weather for a city",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
            additionalProperties: false
          }
        },
        serve: serveWeather
      }],
      context: [],
      output: []
    },
    transitions: []
  })
}

export default actor({
  name: actorName,
  methods: { message: agentMessageMethod },
  components: [infer([
    system(actorInstructions),
    weather,
    nativeOutput
  ])]
})
