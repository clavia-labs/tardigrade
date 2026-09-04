import { actor, agentMessageMethod, agentsPackage, codeMode, fetchPackage, filesPackage, infer, nativeOutput, system } from "tardie"

export default actor({
  name: "react-chat",
  methods: { message: agentMessageMethod },
  components: [infer([
    system("You are a concise coding assistant. Inspect files before answering questions about them."),
    codeMode([filesPackage(), fetchPackage(), agentsPackage()]),
    nativeOutput
  ])]
})
