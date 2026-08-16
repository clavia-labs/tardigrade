# Building a Swarm

This guide builds a multi-agent system in one process: a lead agent, a verifier peer, spawned workers, fan-out from code, and a script the model writes. Every step runs on the in-memory runtime, and a durable runtime takes the same agents unchanged.

`packages/codemode/src/guide.test.ts` runs this walkthrough, so the snippets stay honest.

## Agents, Then Addresses

An [agent](concepts.md#agent) is behavior with no state and a [session](concepts.md#session) is one conversation, so building a swarm is two separate decisions. First construct the agents, one per kind of work. Then hand the runtime a registry that says which addresses they answer at.

Each agent picks its own model through its `inference` module, so a swarm mixes models by construction.

```ts
import { Effect } from "effect"
import {
  callAgent,
  createAgent,
  defaultPack,
  inference,
  keyOf,
  serve,
  subagentTool,
  vercelGatewayInference
} from "flamecast-core/harness"
import { InMemoryRuntime } from "flamecast-core/runtime-in-memory"

const lead = createAgent({
  modules: defaultPack({
    inference: { provider: vercelGatewayInference({ model: "anthropic/claude-opus-4.5", contextWindow: 200_000 }) },
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
      provider: vercelGatewayInference({ model: "anthropic/claude-haiku-4.5", contextWindow: 200_000 }),
      system: "Check the claim you are given. Answer with the defects you find, or 'correct'."
    })
  ]
})
```

The verifier carries no tools and no history. A delegation sends it one message, so it reads the claim with a clean context, which is what makes a verifier worth running.

## Register and Run

```ts
const runtime = InMemoryRuntime({
  keyOf,
  sessions: {
    "agent:lead": serve(lead),
    "agent:verify": serve(verifier)
  }
})

const answer = await Effect.runPromise(
  Effect.provide(callAgent("agent:lead", { id: "m-1", text: "..." }), runtime)
)
```

`serve` turns an agent into what the runtime holds at an address, and the registry says who answers where. `callAgent` sends through `Router` and reads the terminal, so calling one agent and calling a swarm are the same code. When the lead calls its `verify` tool, the runtime creates the `agent:verify` session on first delivery, runs it under its own log and writer lease, and hands the answer back as an ordinary tool result.

## Read the Evidence

Every crossing leaves derived evidence, so a swarm is debugged from its logs. `Sessions` is the read side of the runtime.

```ts
import { Sessions } from "flamecast-core"
import { treeUsageIn } from "flamecast-core/harness"

const evidence = await Effect.runPromise(
  Effect.provide(
    Effect.gen(function* () {
      const sessions = yield* Sessions
      return {
        held: yield* sessions.list,
        childLog: yield* sessions.read("agent:verify"),
        leadLog: yield* sessions.read("agent:lead")
      }
    }),
    runtime
  )
)

// The verifier's inbound head names the lead session, the turn, and the tool call that asked.
const asked = evidence.childLog.find((event) => event.type === "MessageReceived")?.origin
// The lead's own model calls plus everything the verifier reported.
const total = treeUsageIn(evidence.leadLog, "m-1")
```

## Spawn Workers by Address

A `prefix/*` registry entry is a family of agents. The factory receives the concrete address, so it can vary the model, the instruction, or anything else by name. A session appears when its address is first used, and the factory runs once per address.

```ts
const runtime = InMemoryRuntime({
  keyOf,
  sessions: {
    "agent:lead": serve(lead),
    "worker/*": (address) =>
      serve(
        createAgent({
          modules: [inference({ provider: modelFor(address), system: instructionFor(address) })]
        })
      )
  }
})
```

## Fan Out From Code

`callAgent` is delegation as a value, so a deterministic workflow drives workers with no model in the loop. Concurrent calls join on `Promise.all`, and each worker runs under its own writer lease, so the fan-out is parallel.

```ts
const ask = (address: string, id: string, text: string) =>
  Effect.runPromise(Effect.provide(callAgent(address, { id, text }), runtime))

const answers = await Promise.all([
  ask("worker/1", "r-1", "summarize the first half"),
  ask("worker/2", "r-2", "summarize the second half")
])
```

## Let the Model Write the Fan-Out

[Code mode](codemode.md) moves the same shape inside a model-written script. The lead gets one `execute` tool, the script reaches the `agents` capability, and `allow` bounds the addresses it may open. The sandbox is a service the runtime provides, like any other.

```ts
import { Context } from "effect"
import { agents, codemode, inProcessSandbox, Sandbox } from "flamecast-core/codemode"

const execute = codemode({ capabilities: [agents({ allow: ["worker/*"] })] })

const lead = createAgent({
  modules: defaultPack({
    inference: { contextWindow: 200_000 },
    nativeTools: [execute]
  })
})

const runtime = InMemoryRuntime({
  keyOf,
  sessions: { "agent:lead": serve(lead), "worker/*": workerFor },
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

`replyTo` is the asynchronous door. The caller dispatches work and reads the terminal of the dispatch, and the answer arrives later at the named address as a new inbound message stamped with `origin`, `outcome`, and `usage`. [Orchestration](orchestration.md#the-boundary-contract) covers the contract.

```ts
await Effect.runPromise(
  Effect.provide(
    callAgent("worker/9", { id: "j-1", text: "index the archive", replyTo: "agent:lead" }),
    runtime
  )
)
```

## Move It to a Durable Runtime

Everything above the ports is runtime-neutral. On a durable platform an address names a durable object or a cell, the platform owns resolution, storage, and the lease, and the agents, capabilities, and projections move unchanged. [Runtimes](runtimes.md) owns binding status.
