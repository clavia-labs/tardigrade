# Building a Swarm

This guide builds a multi-agent system in one process: a lead agent, a verifier peer, spawned workers, fan-out from code, and a script the model writes. Every step runs on the in-memory pieces, and a durable runtime takes the same agents unchanged.

`packages/codemode/src/guide.test.ts` runs this walkthrough, so the snippets stay honest.

## Programs, Then Addresses

A [program](concepts.md#program) is compiled behavior and a [session](concepts.md#session) is a running conversation, so building a swarm is two separate decisions. First construct the programs, one per kind of agent. Then give the [host](orchestration.md#session-host) a registry that says which addresses run which program.

Each program picks its own model through its `inference` module, so a swarm mixes models by construction.

```ts
import { Effect } from "effect"
import {
  createAgent,
  defaultPack,
  host,
  inference,
  subagentTool,
  vercelGatewayInference
} from "flamecast-core/harness"

const lead = createAgent({
  modules: defaultPack({
    inference: { provider: vercelGatewayInference({ model: "anthropic/claude-opus-4.5" }) },
    nativeTools: [
      subagentTool({
        name: "verify",
        description: "Ask the verifier to check an answer before returning it.",
        address: "agent:verify"
      })
    ]
  })
})

const verifier = createAgent({
  modules: [
    inference({
      provider: vercelGatewayInference({ model: "anthropic/claude-haiku-4.5" }),
      system: "Check the claim you are given. Answer with the defects you find, or 'correct'."
    })
  ]
})
```

The verifier program carries no tools and no history. A delegation sends it one message, so it reads the claim with a clean context, which is what makes a verifier worth running.

## Host and Run

```ts
const h = host({
  programs: {
    "agent:lead": lead,
    "agent:verify": verifier
  }
})

const terminal = await Effect.runPromise(h.call("agent:lead", { id: "m-1", text: "..." }))
```

`h.call` appends the message, settles the lead's machines, and returns the terminal event. When the lead calls its `verify` tool, the host creates the `agent:verify` session on first delivery, runs it under its own log and writer lease, and hands the answer back as an ordinary tool result.

## Read the Evidence

Every crossing leaves derived evidence, so a swarm is debugged from its logs.

```ts
import { treeUsageIn } from "flamecast-core/harness"

const childLog = await Effect.runPromise(h.log("agent:verify"))
const head = childLog.find((event) => event.type === "MessageReceived")
// head.origin names the lead session, the turn, and the tool call that asked.

const leadLog = await Effect.runPromise(h.log("agent:lead"))
const total = treeUsageIn(leadLog, "m-1")
// total covers the lead's own model calls plus everything the verifier reported.
```

## Spawn Workers by Address

A `prefix/*` registry entry is a family of agents. The factory receives the concrete address, so it can vary the model, the instruction, or anything else by name. A session appears when its address is first used, and the factory runs once per address.

```ts
const h = host({
  programs: {
    "agent:lead": lead,
    "worker/*": (address) =>
      createAgent({
        modules: [inference({ provider: modelFor(address), system: instructionFor(address) })]
      })
  }
})
```

## Fan Out From Code

`callAgent` is delegation as a value, so a deterministic workflow drives workers with no model in the loop. Concurrent calls join on `Promise.all`, and each worker runs under its own writer lease, so the fan-out is parallel.

```ts
import { Router } from "flamecast-core"
import { callAgent } from "flamecast-core/harness"

const router = {
  deliver: (address, event) => Effect.asVoid(h.route(address, event)),
  call: h.route
}

const ask = (address: string, id: string, text: string) =>
  Effect.runPromise(Effect.provideService(callAgent(address, { id, text }), Router, router))

const answers = await Promise.all([
  ask("worker/1", "r-1", "summarize the first half"),
  ask("worker/2", "r-2", "summarize the second half")
])
```

## Let the Model Write the Fan-Out

[Code mode](codemode.md) moves the same shape inside a model-written script. The lead gets one `execute` tool, the script reaches the `agents` capability, and `allow` bounds the addresses it may open.

```ts
import { Context } from "effect"
import { agents, codemode, inProcessSandbox, Sandbox } from "flamecast-core/codemode"

const execute = codemode({ capabilities: [agents({ allow: ["worker/*"] })] })

const lead = createAgent({ modules: defaultPack({ nativeTools: [execute] }) })

const h = host({
  programs: { "agent:lead": lead, "worker/*": workerFor },
  services: Context.make(Sandbox, inProcessSandbox())
})
```

A script the model writes then reads like the code above it:

```js
const answers = await Promise.all([
  agents.call("worker/1", "summarize the first half"),
  agents.call("worker/2", "summarize the second half")
])
return answers.map((one) => one.output).join("\n")
```

## Give the Script Your Own Tools

A capability is a named object injected across the sandbox boundary, so any application surface becomes a tool the script calls by name. The capability list is the whole import surface of the sandbox, and the harness developer owns it.

```ts
import { capability } from "flamecast-core/codemode"

const notes = capability({
  name: "notes",
  summary: "Shared notes for this run.",
  methods: [
    {
      name: "save",
      signature: "save(key, text): Promise<void>",
      description: "Keep one note under a key.",
      run: (args) => Effect.sync(() => void store.set(String(args[0]), String(args[1])))
    }
  ]
})

const execute = codemode({ capabilities: [notes, agents({ allow: ["worker/*"] })] })
```

One script can now delegate, combine the answers, and record where they landed, in a single model call.

## Long-Running Work

`replyTo` is the asynchronous door. The lead delivers work and finishes its turn, and the worker's answer arrives later as a new inbound message stamped with `origin`, `outcome`, and `usage`. [Orchestration](orchestration.md#the-boundary-contract) covers the contract.

```ts
await Effect.runPromise(
  h.call("worker/9", { id: "j-1", text: "index the archive", replyTo: "agent:lead" })
)
```

## Move It to a Durable Runtime

The host is the in-process binding of address resolution, and everything above it is runtime-neutral. On a durable platform an address names a durable object or a cell, hosting is the platform's job, and the programs, capabilities, and projections move unchanged. [Runtimes](runtimes.md) owns binding status.
