---
name: tardigrade
description: Build and debug Tardigrade actors and agents with methods, atoms, RPC libraries, and durable event logs. Use for Tardigrade authoring, Bun or Cloudflare hosting, state migration, and trace-driven harness improvements.
---

# Tardigrade

Build from the boundary inward: define what the outside world can ask, which event that records, which atoms react, and how the caller receives a result. Keep execution wiring separate from this graph.

## 1. Methods bring the world into the log

A method is a typed entrance to a thread. `actorMethod` validates input, maps it to a domain event through `onReceive`, and projects an invocation result through `result`. Use a declared event's `.from(...)` to construct the mapping. A method can represent a user message, a webhook, a scheduled task, or another actor's request.

```text
outside input + invocation ID
             |
             v
       method.onReceive
             |
             v
       recorded domain event
             |
             v
       atoms react to the log
             |
             v
       method.result(state, invocation)
             |
             +--> undefined: pending
             +--> completed / failed / cancelled: terminal reply
```

`result` reads state; it does not execute the work. For asynchronous methods, associate state with `context.id` or `context.ref` and return a terminal result for that invocation. Reading the latest global answer can deliver another invocation's reply. `agentMethods.message` already handles this correlation for inference turns.

## 2. Atoms turn history into state and behaviour

```text
                     event log
                         |
                   durable atoms
                         |
                   derived atoms
                         |
                    effect atoms
                   /      |      \
                view    events    acts
                          |        |
                          |     services execute I/O
                          |        |
                          +--------+--> recorded results --> log
```

| Atom | Responsibility | Persistence |
| --- | --- | --- |
| `atom(value)` | Supply a value to the graph | No durable history by itself |
| `atom(get => ...)` | Derive a value from dependencies | Recomputed from dependencies |
| `durableAtom({ name, input, schema, initial, reduce })` | Fold matching recorded events into state | Rebuilt from events or seeded state |
| `effectAtom(get => ({ view, events, acts }))` | Project state and propose transitions or external work | The runtime records accepted work and results |

Keep atom reads, reducers, and result projections free of external I/O. Preserve unchanged state references in reducers and do not mutate inputs. A durable atom's name identifies its checkpoint and migration state; changing its name or codec is a compatibility decision.

The public output field is `acts`. In explanations, call these effects or proposed work. An effect atom proposes work; an Effect service implements it. A derived view is a projection of state, and the method reply is a projection for a particular invocation.

### A complete counter

```ts
import { Effect, Schema } from "effect"
import { actorMethod, atom, defineActor, durableAtom, event } from "tardie/core"

const Added = event({ type: "Added", amount: Schema.Finite })
const count = durableAtom({
  name: "counter.count",
  input: Added,
  schema: Schema.Finite,
  initial: 0,
  reduce: (state, event) => state + event.amount,
})
const view = atom(get => ({ count: get(count) }))

const methods = {
  add: actorMethod({
    inputSchema: Schema.Finite,
    outputSchema: Schema.Finite,
    onReceive: Added.from(amount => ({ amount })),
    result: (_, get) => ({ status: "completed", output: get(count) }),
  }),
}

export default defineActor("counter", Effect.succeed({ atom: view, methods }))
```

The caller supplies `2`; the method records `Added`; the durable atom becomes `2`; the derived view becomes `{ count: 2 }`; the method projects `2` as its reply. No effect is needed for this transition.

For external work, declare an `act`, create a request with a stable tag, and propose it from an effect atom. Implement it through the act's layer in host services. Recorded outcomes drive the next transition. Inspect the [Greeter](../../packages/examples/agents/greeter.ts) for the request shape. Withdraw direct event proposals when the log reflects them; an unconditional proposal can keep the runtime busy.

## 3. Compose an agent from the same pieces

```ts
import { Effect } from "effect"
import { atom, defineActor } from "tardie/core"
import { agentMethods, compact, infer, messages, tools as libraryTools } from "tardie/agent"

export default defineActor("researcher", Effect.gen(function* () {
  const system = atom("Research carefully. Cite sources and acknowledge uncertainty.")
  const tools = yield* libraryTools()
  const context = yield* compact(messages, { triggerRatio: 0.8, retainRatio: 0.5 })
  const agent = yield* infer(atom(get => ({
    system: get(system),
    tools: get(tools),
    context: get(context),
  })))
  return { atom: agent, methods: agentMethods }
}))
```

`agentMethods.message` maps input to `TurnRequested`. Durable trajectory state records messages and results; `messages` projects it into model messages. `compact` derives context and proposes summarisation when needed. `infer` proposes model and tool work until the turn settles. Its recorded state supplies the method reply.

`compact`, `infer`, `tools`, and `codeMode` construct atoms through Effects; yield them during actor setup. `tools()` selects the host catalog. Pass a library list to restrict selection. The host must supply model metadata, credentials, and matching executable services. Returning an actor definition alone supplies none of these.

Expose defaults and consumer overrides for thresholds, caps, and timeouts. Make policy effects visible in model-facing output, such as a truncation flag and the applied limit. Read the atom implementation before extending it; simplified README sketches omit helpers.

## 4. Libraries separate contracts from execution

```text
RPC declaration + method annotations
                 |
             defineLibrary
              /       \
    actor selection   .implement(handlers)
          |                   |
 tools / codeMode     toolActs / codeModeActs
          |                   |
   proposed calls ------> validated execution
```

Use Effect `Rpc.make` payload, success, and error schemas in `defineLibrary({ name, description, methods })`. `library.methods` remains an ordinary `RpcGroup`. `MethodDescription` explains a method; `MethodHints` carries MCP-compatible read-only, destructive, idempotent, and open-world hints; `MethodExecution` selects `foreground` or `background`. Hints describe behaviour and do not grant permissions.

| Actor adapter | Host implementation | Model interface |
| --- | --- | --- |
| `tools(libraries)` | `toolActs(implementations)` | Individual method tools |
| `codeMode(libraries)` | `codeModeActs(implementations)` plus an isolate | Namespaced methods inside code |

Foreground methods can perform asynchronous I/O and return a value. Background methods return durable handles; submitted external handles use `.implement(..., { submit, cancel })`. Code mode accepts foreground methods. Library adapters support unary RPCs without middleware. A live Cloudflare RPC reference is a transport capability, not a durable background handle.

Built-in factories such as `arxiv()` and `workspace()` return implementations with a `.library` contract. Actor declarations may select those contracts; execution layers supply implementations and dependencies. `arxiv` returns an Atom XML feed with pagination metadata. `memoryWorkspace` is ephemeral; use a persistent `Workspace` implementation when writes must survive restart. See the [SDK library example](../../docs/references/sdk.mdx#libraries) for a custom method and wiring.

## 5. Host, verify, migrate

Read only the reference needed for the task:

- [Run and deploy](references/run-and-deploy.md): CLI scaffolding, service wiring, real-model checks, Cloudflare deployment, retries, and diagnosis.
- [State and compatibility](references/state-and-compatibility.md): replay, checkpointing, initialisation, settled boundaries, and storage ownership.
- [NPO](references/npo.md): improve one prompt lineage from scored traces.
- [GEPA](references/gepa.md): compare a candidate pool using case-level tradeoffs.

For harness changes, fix cases, scoring, model selection, and limits across candidates. Use fresh threads and preserve complete trajectories, source digests, and comparable outcomes. Deployment and external evaluation stay within the user's authorized scope.

## Public surface and source map

```text
tardie/core                  methods, atoms, actors, runtime, initialisation
tardie/agent                 agent authoring and message methods
tardie/agent/services        model, tool, and code execution wiring
tardie/libraries             RPC contracts and built-in libraries
tardie/model                 model configuration, locks, provider layers
tardie/platform/bun          Bun host, storage, method HTTP adapter
tardie/platform/cloudflare   Durable Object host and method HTTP adapter
tardie/code                  code execution and sandboxes
tardie/deprecated            component APIs
```

Use public imports; bare `tardie` has no authoring API. Keep component APIs separate from atom APIs. In this repository, sources live under `packages/{core,agent,libraries,model,platform}/src`; published `tdg` lives in `apps/cli`, while the chat actor CLI lives in `packages/apps/cli`. Consult [README](../../README.md), [SDK](../../docs/references/sdk.mdx), and [quickstart templates](../../examples/quickstart/) for exact signatures. Outside the repository, inspect the installed package and matching published docs before assuming the scaffold matches this checkout.
