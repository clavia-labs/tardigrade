import { Clock, Context, Effect } from "effect"
import { Router } from "@tardigrade/core/router"
import type { Package } from "@tardigrade/code/packages"
import type { Event } from "@tardigrade/core/event"
import { budgetPolicyOf, type BudgetPolicy } from "./budget"
import { Park } from "@tardigrade/code/errors"
import { readAddress } from "@tardigrade/core/router"
import { replyId } from "@tardigrade/core/reply"

// The agents package: ad-hoc agents, reachable from code like any other package. One verb with a
// delivery mode: `agents.run({text})` runs a fresh agent to quiescence and returns its terminal;
// `agents.run({text, background: true})` delivers the brief and returns a pending handle, and
// `agents.result({id})` awaits that handle's reply later.
//
// Every call is its own agent: the child's identity is the call's id, so a Promise.all of five
// runs is five agents by construction, and no name exists to collide on. A persistent named
// colleague is a later explicit feature, never an accident of naming.
//
// Durability costs nothing here: both modes are package calls, so the recorded pair replays a
// committed run and re-delivers a crashed dispatch. The call id is the child's identity AND the
// message id, so a replayed dispatch reaches the same child and is absorbed as a duplicate.
//
// `place` is the placement policy: the call's id in, the child's address out. The caller never
// learns where the child lives; the platform's default colocates children as sibling facets of
// the parent's host, and a remote child is one different returned string.
//
// A plain foreground run parks, the same mechanism `tasks.fire` (`src/packages/tasks.ts`) uses:
// deliver the brief with `replyTo` this lane, then await the reply row on this lane, host-side
// `Park` when it has not landed yet (`src/code/execute.ts`'s proxy is what turns that into a
// promise that never settles for the code body). It never holds a call open.
//
// An escalatable run is the one residual exception. An escalating child's ask for more budget
// rides `router.call`'s own `CallResult.requesting` boundary (`src/core/router.ts`,
// `src/agent/boundary.ts`): the platform's `call` RPC runs the child to its wall and reads the
// ask straight off its settle, synchronously, in the SAME round trip; `agents.continue` answers
// it with `router.resume`, another synchronous round trip to the child's next boundary. Nothing
// carries that ask as a message the child could otherwise send home, so there is no reply row to
// park on until the child is done asking. An escalatable spawn holds its call open; a plain one
// parks.

// SpawnOptions is the placement's environment: who the family works as, how a child's budget is
// drawn from the run, and the isolation labels a brief carries down. Every field has a default,
// and `budget` is one of them rather than a constant this module reads: a spawn with no stated
// budget takes the same ceiling the child's own reactor would, and a consumer that moved that
// ceiling moves both (budget.ts, BudgetPolicy).
export interface SpawnOptions {
  readonly agentOf?: () => string | undefined
  readonly subjectOf?: () => string | undefined
  readonly reserve?: (callId: string, want: number) => Promise<number>
  readonly shadowOf?: () => boolean
  // The parent's explicit world label, when its own fire named a shared world instead of taking
  // the anonymous one (docs/worlds.md). Forwarded onto every spawn's brief the same way `shadow`
  // is, so a whole family stays on one shared world's facets.
  readonly worldOf?: () => string | undefined
  readonly budget?: Partial<BudgetPolicy>
}

export const agentsPackage = (
  router: Context.Service.Shape<typeof Router>,
  self: string,
  place: (callId: string) => string,
  reader: AgentReader,
  options: SpawnOptions = {}
): Package => {
  const agentOf = options.agentOf ?? (() => undefined)
  const subjectOf = options.subjectOf ?? (() => undefined)
  const reserve = options.reserve ?? (async (_callId: string, want: number) => want)
  const shadowOf = options.shadowOf ?? (() => false)
  const worldOf = options.worldOf ?? (() => undefined)
  const defaultBudget = budgetPolicyOf(options.budget).defaultToolBudget
  return {
    name: "agents",
    description: "Ad-hoc agents. run({text}) starts a fresh agent with the brief and waits for its answer; add background: true for a long job, and result({id}) awaits the reply later. An escalatable run can ask for more budget at its wall; continue() answers the ask.",
    annotations: {
      run: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      result: { readOnlyHint: true, openWorldHint: false },
      continue: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    docs: {
      run: {
        description: "Brief a fresh agent. `output` (a JSON schema) makes the answer structured and parsed. `model` picks the mind: haiku for quick, cheap work like scouting; sonnet (default) for most work; terra for balanced OpenAI writing; sol for the hardest judgment; opus when explicitly configured. `budget` caps the agent's tool calls: at the cap it answers with its best result, so a research agent can not run forever. `background: true` returns `{ callId }` at once; result({id: callId}) awaits the reply later. `escalatable: true` lets the agent ask for more budget at the cap instead of answering; the run then returns `{ requesting, reason, amount, handle }`, and you decide with continue().",
        input: {
          type: "object",
          properties: {
            text: { type: "string", description: "the brief" },
            background: { type: "boolean", description: "true: return { callId } at once, the reply arrives later via result()" },
            output: { type: "object", description: "JSON schema for a structured answer" },
            model: { type: "string", enum: ["haiku", "sonnet", "opus", "terra", "sol"], description: "which model runs the agent; default sonnet" },
            budget: { type: "number", description: "max tool calls before the agent must answer; keeps a research agent bounded" },
            escalatable: { type: "boolean", description: "true: at its budget the agent may ask for more instead of answering; the run returns a request you resolve with continue()" }
          },
          required: ["text"]
        },
        output: { type: "object", properties: { output: { description: "the agent's answer; parsed when a schema was given" } } }
      },
      result: {
        description: "Await a run fired with `background: true`. Answers its terminal once the reply lands; parks the execution until then. `output` re-applies a JSON schema to a structured answer.",
        input: {
          type: "object",
          properties: { id: { type: "string", description: "the callId a background run answered" }, output: { type: "object", description: "JSON schema for a structured answer" } },
          required: ["id"]
        },
        output: { type: "object", properties: { output: { description: "the agent's answer; parsed when a schema was given" } } }
      },
      continue: {
        description: "Resolve a budget request from an escalatable run. Pass the request's `handle` and a `grant` of extra tool calls; a grant of 0 or less denies, and the agent finishes with what it has. A grant draws the run's shared budget, so a spent budget denies whatever you pass. Returns the agent's next boundary: another request, or its final answer, in the same shape run() returns.",
        input: {
          type: "object",
          properties: {
            handle: { type: "object", description: "the handle from a requesting run" },
            grant: { type: "number", description: "extra tool calls to grant; 0 or less denies" }
          },
          required: ["handle", "grant"]
        },
        output: { type: "object", properties: { output: { description: "the agent's answer, or a further request" } } }
      }
    },
    methods: {
      run: (args, ctx) =>
        Effect.gen(function* () {
          const a = args as
            | { text?: unknown; background?: unknown; output?: unknown; outputSchema?: unknown; model?: unknown; budget?: unknown; escalatable?: unknown }
            | undefined
          const text = String(a?.text ?? "")
          if (text === "") return { error: "agents.run needs { text }" }
          // The schema parameter is `output`, and a near-miss spelling fails silently: no schema
          // means a prose answer, so the caller's field reads come back undefined and the run
          // returns something plausible and wrong. Say so instead.
          if (a?.output === undefined && a?.outputSchema !== undefined) {
            return { error: "agents.run takes the schema as `output`, not `outputSchema`" }
          }
          const output = a?.output
          // The model name rides the brief's envelope: the child's log records the choice, so its
          // Infer resolves it from trajectory and replay agrees by construction.
          const model = a?.model === "haiku" || a?.model === "sonnet" || a?.model === "opus" || a?.model === "terra" || a?.model === "sol" ? a.model : undefined
          // The tool-call budget rides the brief like the model does; the child's budget reactor reads
          // it from its own trajectory. A run without a stated budget wants the per-agent default.
          const want = typeof a?.budget === "number" && a.budget > 0 ? Math.floor(a.budget) : defaultBudget
          // Draw from the run's single budget before the child spawns, so the whole tree is bounded by
          // it whatever the fan-out. A partial budget grants what is left; a spent budget grants 0, and
          // then no agent spawns, which is how the tree stops. The draw is keyed on this call's id, so
          // a re-driven code body reuses its grant and never draws twice.
          const budget = yield* Effect.promise(() => reserve(ctx.callId, want))
          if (budget <= 0) return { error: "the run's budget is exhausted; no budget to spawn this agent" }
          // The child works as the same member the parent does: the actor rides every brief in the
          // family, so a run's whole tree resolves connections identically.
          const actor = agentOf()
          const subject = subjectOf()
          // The parent's own shadow reading, never the tool args: an agent cannot set or unset it, so
          // a whole run family is shadow by construction from the fire alone. `world` rides along
          // the same way, when the fire named an explicit shared one.
          const shadow = shadowOf()
          const world = worldOf()
          const address = place(ctx.callId)
          if (a?.background === true) {
            // A background run has no synchronous parent to decide an escalation, so it never asks:
            // the brief carries no `escalatable`, and the reply comes home as an inbound, awaited
            // later by `agents.result({ id: callId })`.
            const at = yield* Clock.currentTimeMillis
            yield* router.deliver(address, {
              type: "MessageReceived",
              id: ctx.callId,
              text,
              ...(output === undefined ? {} : { output }),
              ...(model === undefined ? {} : { model }),
              budget,
              ...(actor === undefined ? {} : { actor }),
              ...(subject === undefined ? {} : { subject }),
              ...(shadow ? { shadow: true } : {}),
              ...(world === undefined ? {} : { world }),
              replyTo: self,
              from: self,
              at
            })
            return { dispatched: true, callId: ctx.callId }
          }
          // Escalation is a foreground affordance, and the one shape that still holds its call
          // open: see the module comment for why. Every other foreground run parks below.
          if (a?.escalatable === true) {
            const answer = yield* router.call(address, {
              id: ctx.callId,
              text,
              ...(output === undefined ? {} : { output }),
              ...(model === undefined ? {} : { model }),
              budget,
              escalatable: true,
              ...(actor === undefined ? {} : { actor }),
              ...(subject === undefined ? {} : { subject }),
              ...(shadow ? { shadow: true } : {}),
              ...(world === undefined ? {} : { world })
            })
            return shape(answer, address, ctx.callId, output !== undefined)
          }
          // Plain foreground: the same park logic `tasks.fire` uses. A reply already on the lane
          // (a replayed attempt) answers at once, with no re-delivery; otherwise the brief goes
          // out with `replyTo` this lane, exactly the background delivery above, and the host
          // parks this call until the reply lands.
          const already = yield* awaitedReply(reader, self, ctx.callId)
          if (already !== undefined) return shape(answerOf(already), address, ctx.callId, output !== undefined)
          const at = yield* Clock.currentTimeMillis
          yield* router.deliver(address, {
            type: "MessageReceived",
            id: ctx.callId,
            text,
            ...(output === undefined ? {} : { output }),
            ...(model === undefined ? {} : { model }),
            budget,
            ...(actor === undefined ? {} : { actor }),
            ...(subject === undefined ? {} : { subject }),
            ...(shadow ? { shadow: true } : {}),
            ...(world === undefined ? {} : { world }),
            replyTo: self,
            from: self,
            at
          })
          return yield* Effect.fail(new Park({ callId: ctx.callId, awaiting: replyId(ctx.callId) }))
        }),
      // Await a run already fired in the background: no delivery, the same reply-or-park read the
      // plain foreground branch of `run` takes. `id` is the `callId` an earlier `background: true`
      // run answered.
      result: (args, ctx) =>
        Effect.gen(function* () {
          const a = args as { id?: unknown; output?: unknown } | undefined
          const id = String(a?.id ?? "")
          if (id === "") return { error: "agents.result needs { id }" }
          const reply = yield* awaitedReply(reader, self, id)
          if (reply !== undefined) return shape(answerOf(reply), "", id, a?.output !== undefined)
          return yield* Effect.fail(new Park({ callId: ctx.callId, awaiting: replyId(id) }))
        }),
      // Resume a child parked on a budget ask. `grant` is the tool calls to add; a non-positive grant,
      // or a spent run budget, denies and the child finishes. The grant draws the run's budget like a
      // fresh spawn does, so escalation stays inside the same whole-run bound. Returns the child's next
      // boundary, another request or its final answer, in the same shape `run` returns.
      continue: (args, ctx) =>
        Effect.gen(function* () {
          const a = args as { handle?: unknown; grant?: unknown } | undefined
          const handle = a?.handle as { address?: unknown; turn?: unknown; structured?: unknown } | undefined
          const address = String(handle?.address ?? "")
          const turn = String(handle?.turn ?? "")
          if (address === "" || turn === "") return { error: "agents.continue needs { handle, grant }; the handle comes from a run that is requesting" }
          const want = typeof a?.grant === "number" ? Math.floor(a.grant) : 0
          const granted = want > 0 ? yield* Effect.promise(() => reserve(ctx.callId, want)) : 0
          const decision = granted > 0 ? { amount: granted } : { amount: 0, reason: "the parent declined the request" }
          const answer = yield* router.resume(address, turn, decision)
          return shape(answer, address, turn, handle?.structured === true)
        })
    }
  }
}

// AgentReader reads one facet's committed events. `run` (awaiting) and `result` use it to check
// whether a spawned child's reply has already landed, before ever parking: the same shape
// `tasks.ts` (`TaskReader`) reads its own lane with.
export interface AgentReader {
  readonly events: (facet: string) => Promise<ReadonlyArray<Event>>
}

// SpawnTerminal is a spawned child's terminal, once its reply has landed on the calling lane.
interface SpawnTerminal {
  readonly outcome: "completed" | "failed"
  readonly text: string
}

// awaitedReply returns the reply row for one spawn, if it has landed on the calling lane. `id`
// is `replyEvent`'s own convention (`src/core/reply.ts`): `<id>.reply` (`replyId`,
// `src/grammar/grammar.ts`), so a redelivered brief dedups at the sender and a redelivered reply
// dedups at the receiver.
const awaitedReply = (reader: AgentReader, self: string, id: string): Effect.Effect<SpawnTerminal | undefined> =>
  Effect.promise(async () => {
    const facet = readAddress(self).facet
    const events = await reader.events(facet)
    const reply = events.find(
      (e) => e.type === "MessageReceived" && (e as { id?: unknown }).id === replyId(id)
    ) as { outcome?: unknown; text?: unknown } | undefined
    if (reply === undefined) return undefined
    return { outcome: reply.outcome === "failed" ? "failed" : "completed", text: String(reply.text) }
  })

// answerOf strips `replyEvent`'s "error: " prefix back off a failed reply, so a foreground
// body's `.error` reads the bare text while the fresh-inbound reading a background reply keeps
// the convention.
const ERROR_PREFIX = "error: "
const answerOf = (reply: SpawnTerminal): { output?: string; error?: string } =>
  reply.outcome === "completed"
    ? { output: reply.text }
    : { error: reply.text.startsWith(ERROR_PREFIX) ? reply.text.slice(ERROR_PREFIX.length) : reply.text }

// shape renders a boundary as the code's return value. A request carries a handle the code passes back to
// `agents.continue`; `structured` rides the handle so a later grant parses the schema'd answer the
// same way the first `run` would. A schema'd terminal comes back parsed, a prose one raw.
const shape = (
  answer: { output?: string; error?: string; requesting?: boolean; reason?: string; amount?: number },
  address: string,
  turn: string,
  structured: boolean
): unknown => {
  if (answer.requesting === true) {
    return { requesting: true, reason: answer.reason, amount: answer.amount, handle: { address, turn, structured } }
  }
  if (structured && answer.output !== undefined) {
    try {
      return { output: JSON.parse(answer.output) }
    } catch {
      return answer
    }
  }
  return answer
}
