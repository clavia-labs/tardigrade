// The README's quickstart, runnable: an agent is reactors over one log.
//   MODEL_BASE_URL=... MODEL_API_KEY=... MODEL_ID=... MODEL_PROVIDER=bedrock bun examples/quickstart.ts
import { Effect, Layer } from "effect"
import { actor } from "@flamecast/core/actor"
import { composeKeys } from "@flamecast/core/event-log"
import { messageKeys } from "@flamecast/core/message"
import { codeReactor, codeKeys } from "@flamecast/code"
import { jsSandbox, memoryTmp } from "@flamecast/code/defaults"
import { Packages } from "@flamecast/code/packages"
import { agentKeys, budgetReactor, compactionReactor, inferReactor, replyReactor, toolsReactor } from "@flamecast/agent"
import { realInfer } from "@flamecast/model/model"
import { createBunHost } from "@flamecast/bun/host"

// Adding a capability is adding a reactor to the list.
const agent = actor(
  [inferReactor, budgetReactor, toolsReactor, codeReactor, replyReactor, compactionReactor],
  composeKeys(messageKeys, codeKeys, agentKeys)
)

// The wiring: a real model through platform/model, a sandbox for the agent's code, no packages.
const wiring = () =>
  Layer.mergeAll(
    realInfer({
      baseUrl: process.env.MODEL_BASE_URL!,
      apiKey: process.env.MODEL_API_KEY!,
      model: process.env.MODEL_ID!,
      ...(process.env.MODEL_PROVIDER === undefined ? {} : { provider: process.env.MODEL_PROVIDER }),
      packagesInScope: "none",
      maxOutputTokens: 64_000
    }),
    Layer.succeed(Packages, { resolve: () => undefined, list: () => Effect.succeed([]) }),
    jsSandbox,
    memoryTmp()
  )

const host = await createBunHost({ path: "agents.sqlite", actorFor: () => agent, layersFor: wiring })
await host.deliver("bun:main", { type: "MessageReceived", id: "m1", text: "In one sentence: what is an event log?", at: Date.now() })
await host.drive()

const events = await host.read("main")
const done = events.findLast((e) => e.type === "TurnCompleted") as { output?: string } | undefined
console.log(done?.output ?? "no terminal yet")
await host.close()
