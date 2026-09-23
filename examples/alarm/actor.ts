import { actor } from "tardie/core"
import { agentMethods, infer, nativeOutput, system, tools } from "tardie/agent"
import { alarm } from "tardie/code"

export default actor({
  name: "tardie",
  methods: agentMethods,
  components: [
    infer(({ message }) => [
      system(`You are a friendly assistant.
Use alarms to schedule reminders. When an alarm's note arrives as a message,
respond to it without scheduling it again.`),
      tools([
        alarm({ onFired: alarm => message({ text: alarm.note }) }),
      ]),
      nativeOutput,
    ]),
  ],
})
