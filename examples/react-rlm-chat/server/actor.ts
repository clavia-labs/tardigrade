import { actor } from "tardie/deprecated/core"
import { agentMethods, agents, budget, caller, escalate, codeMode, compact, messages, infer, outputValidateOnce, system } from "tardie/deprecated/agent"
import { fetch, workspace } from "tardie/code"

const actorName = "react-chat"

const actorInstructions = `
You are a research assistant.
Use fetched sources and delegated work when they improve the answer.
Return a clear answer with concrete findings.
`.trim()

export default actor({
  name: actorName,
  methods: agentMethods,
  components: [
    infer([
      system(actorInstructions),
      escalate(
        budget(codeMode([fetch(), agents({ maxDepth: 2 }), workspace()]), {
          onExhausted: (reason, settle) => settle({ error: reason }),
          usage: (observation) => observation.calls.length,
          rejectionMessage: "Tool budget reached. Answer now with your best result."
        }),
        { authority: caller(), requests: { decide: request => request.grant() } }
      ),
      compact(messages()),
      outputValidateOnce
    ])
  ]
})
