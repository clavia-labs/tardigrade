---
title: Ask a human from a turn
description: Park an agent turn on a schema-shaped question and resume when the answer is durable.
route: /docs/human-asks
section: How To
order: 31
---

Mount `ask` when a turn must wait for a human fact or decision. The model calls the `ask` tool with a prompt and a JSON Schema. The component records `AskRequested` and parks until `AskAnswered` or `AskDenied` lands on the same thread. The answer is validated against the schema before the tool returns, so the model sees a value of that contract.

The schema uses the same closed object profile as output contracts: every property is required, and `additionalProperties` is `false`. Pass a schema at assembly time when every ask on that actor uses one contract. Omit it when the model chooses a schema per question.

```ts
import { actor } from "tardie/core"
import { agentMethods, ask, budget, codeMode, compaction, infer, nativeOutput } from "tardie/agent"

const APPROVAL = {
  type: "object",
  properties: {
    approved: { type: "boolean", description: "Whether the human accepts the proposed action." },
    note: { type: "string", description: "Anything the agent should know before it continues." }
  },
  required: ["approved", "note"],
  additionalProperties: false
}

export const analyst = actor({
  name: "analyst",
  methods: agentMethods,
  components: [
    infer([
      ask([budget([codeMode()])], { schema: APPROVAL }),
      compaction(),
      nativeOutput
    ])
  ]
})
```

`boundaryOf(log, turn)` reads `kind: "asking"` while the question is unanswered. `turnViewOf(log, turn)` is the client `TurnView`: `status` is `"parked"` and `ask` carries `{ kind: "schema", callId, prompt, schema }`. A budget wall still reads as `{ kind: "budget", callId, reason, amount }` on the same field. A terminal wins over a park, so a later `TurnCompleted` is completed.

Append the human's reply through the thread log. `callId` is the parked ask's id. `answer` must satisfy the recorded schema. `AskDenied` unparks with `{ denied: true }` so the model can finish without that fact.

```ts
import { turnViewOf } from "tardie/agent"

declare const log: ReadonlyArray<{ readonly type: string; readonly id?: string }>
declare const append: (event: { readonly type: string; readonly callId: string; readonly answer?: unknown; readonly turn: string; readonly at: number }) => Promise<void>

export const answerParkedAsk = async (turn: string, answer: { approved: boolean; note: string }, at: number) => {
  const view = turnViewOf(log as never, turn)
  if (view.status !== "parked" || view.ask?.kind !== "schema") return
  await append({ type: "AskAnswered", callId: view.ask.callId, answer, turn, at })
}
```

The HTTP client follows the same shape. `resume` refuses a parked epoch, because resume starts the next execution after a failure, and an unanswered ask is still the current epoch. Answer the ask, then wait for the turn to continue.

```ts
import { makeActorClient, turnViewOf } from "tardie/client"

const client = makeActorClient({ baseUrl: "http://localhost:4242" })

const events = await client.events("main", "root")
const view = turnViewOf(events.map((row) => row.event), "m1")
if (view.status === "parked" && view.ask?.kind === "schema") {
  await client.append("main", "root", {
    type: "AskAnswered",
    callId: view.ask.callId,
    answer: { approved: true, note: "ship it" },
    turn: "m1"
  })
}
```

An optional `authority` sends `requestAsk` to another actor for the decision. `askCaller()` selects the actor that invoked the current message. `askAuthority({ decide })` decides locally. `askAuthority.manual()` leaves `requestAsk` pending so an external process can append `AskRequestDecided`. The agent records `AskRequested` / `AskAnswered` / `AskDenied` on its own log, so `boundaryOf` and `TurnView` remain readable without following the authority call.

```ts
import { actor } from "tardie/core"
import { agentMethods, ask, askAuthority, budget, codeMode, compaction, infer, nativeOutput, requestAskMethod } from "tardie/agent"

export const human = actor({
  name: "human",
  methods: { requestAsk: requestAskMethod },
  components: [askAuthority.manual()]
})

export const worker = actor({
  name: "worker",
  methods: agentMethods,
  components: [
    infer([
      ask([budget([codeMode()])], {
        authority: { coordinate: { actor: "human", instance: "main", thread: "inbox" }, methods: { requestAsk: requestAskMethod } },
        timeoutMs: 3_600_000
      }),
      compaction(),
      nativeOutput
    ])
  ]
})
```

`timeoutMs` bounds the authority call. When omitted, the call uses `DEFAULT_ACTOR_METHOD_TIMEOUT_MS` from the actor method. When set, it must be a positive safe integer. Same-thread answers have no timeout: the turn stays parked until `AskAnswered` or `AskDenied` is recorded.

`requestAskMethod` uses Effect schemas `AskRequestInput` and `AskDecision`. The per-ask JSON Schema is the `schema` field on that input. A local authority validates `answered` against that schema before it records `AskRequestDecided`. An invalid same-thread `AskAnswered` becomes a tool error, so the model can ask again under a new `callId`.
