import { Clock, Effect } from "effect"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { Self } from "@clavia/tardigrade-core/actor"
import { EventLog } from "@clavia/tardigrade-core/event-log"
import { Facets } from "@clavia/tardigrade-core/facets"
import { definePackage, type Package } from "@clavia/tardigrade-code/packages"
import { budgetPolicyOf, type BudgetPolicy } from "./components/budget"
import { Park } from "@clavia/tardigrade-code/errors"
import { boundaryId } from "@clavia/tardigrade-core/communication/message"
import { linkOf } from "@clavia/tardigrade-core/communication/link"
import { envelopeOf } from "@clavia/tardigrade-core/communication/envelope"
import { childLineageOf, threadCreatedOf } from "@clavia/tardigrade-core/thread"
import {
  actorIdOf,
  formatActorId,
  parseActorId,
  type ActorId
} from "@clavia/tardigrade-core/communication/endpoint"
import { declarationForTurn, decodeOutput, outputFrom, type OutputContract } from "./output"
import { budgetDenied, budgetGranted } from "./events"

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
// The package is a value any consumer mounts: its host privileges are services, not constructor
// arguments. `Router` sends, `Self` names the calling lane, and `Facets` reads that
// lane's committed replies (`@clavia/tardigrade-core/facets`). `EventLog` supplies the durable creation record from which a child delivery derives lineage.
//
// place selects the child's actor address from the call id and parent address. The host resolves
// that stable identity to current placement when it interprets the resulting link.
//
// A plain foreground run parks, the same mechanism `tasks.fire` (`src/packages/tasks.ts`) uses:
// deliver the brief through a link from this lane, then await the reply row on this lane, host-side
// `Park` when it has not landed yet (`src/code/execute.ts`'s proxy is what turns that into a promise
// that never settles for the code body). It never holds a call open.
//
// An escalatable run uses the same parked delivery protocol. The child reports each budget request
// through the reversed accepted link, and `agents.continue` sends the parent's decision back through
// Router before parking on the child's next boundary.

// SpawnOptions is the placement's environment: who the family works as, how a child's budget is
// drawn from the run, and the isolation labels a brief carries down. Every field has a default,
// and `budget` is one of them rather than a constant this module reads: a spawn with no stated
// budget takes the same ceiling the child's own reactor would, and a consumer that moved that
// ceiling moves both (budget.ts, BudgetPolicy).
export interface SpawnOptions {
  // The output contracts a spawning body may ask a child for, by name. Model-authored code has
  // no TypeScript checking (packages/code/src/execute.ts runs it through AsyncFunction), so a
  // name resolved here is the only path where the schema was proved at compile time by the host
  // that declared it. A raw schema stays reachable and is preflighted instead (docs/output.md).
  readonly outputs?: Readonly<Record<string, OutputContract>>
  readonly actorNameOf?: () => string | undefined
  readonly reserve?: (callId: string, want: number) => Promise<number>
  readonly shadowOf?: () => boolean
  // The parent's explicit world label, when its own fire named a shared world instead of taking
  // the anonymous one (docs/worlds.md). Forwarded onto every spawn's brief the same way `shadow`
  // is, so a whole family stays on one shared world's facets.
  readonly worldOf?: () => string | undefined
  readonly budget?: Partial<BudgetPolicy>
}

const continuationHandleSchema = {
  type: "object",
  properties: {
    address: { type: "string" },
    turn: { type: "string" },
    round: { type: "integer" },
    request: { type: "string" }
  },
  required: ["address", "turn", "round", "request"]
}

const foregroundBoundarySchema = {
  type: "object",
  properties: {
    output: {},
    error: { type: "string" },
    requesting: { type: "boolean" },
    reason: { type: "string" },
    amount: { type: "number" },
    handle: continuationHandleSchema
  }
}

// sibling is the default placement: the child is a facet of the parent's own principal, named `ag.<callId>`. The address selects the target while ThreadCreated records its lineage (spawn.test.ts, "the default placement is the host's own sibling address"; tla/runtime/Thread.tla, CreationFirst).
const sibling = (callId: string, self: ActorId): ActorId =>
  actorIdOf(self.actor, `ag.${callId}`)

export const agentsPackage = (
  options: SpawnOptions & { readonly place?: (callId: string, self: ActorId) => ActorId } = {}
): Package<Router | Self | Facets | EventLog> => {
  const place = options.place ?? sibling
  const actorNameOf = options.actorNameOf ?? (() => undefined)
  const reserve = options.reserve ?? (async (_callId: string, want: number) => want)
  const shadowOf = options.shadowOf ?? (() => false)
  const worldOf = options.worldOf ?? (() => undefined)
  const defaultBudget = budgetPolicyOf(options.budget).defaultToolBudget
  const outputs = options.outputs ?? {}
  const declared_ = Object.keys(outputs)
  return definePackage({
    name: "agents",
    description: "Ad-hoc agents. run({text}) starts a fresh agent with the brief and waits for its answer; add background: true for a long job, and result({id}) awaits the reply later. An escalatable run can ask for more budget at its wall; continue() answers the ask.",
    annotations: {
      run: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      result: { readOnlyHint: true, openWorldHint: false },
      continue: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    docs: {
      run: {
        description: `Brief a fresh agent. \`output\` makes the result structured and parsed: the name of a declared contract${declared_.length === 0 ? " (this host declares none)" : ` (${declared_.join(", ")})`}, or a JSON schema of your own. \`model\` picks the mind: haiku for quick, cheap work like scouting; sonnet (default) for most work; opus for the hardest judgment. \`budget\` caps the agent's tool calls: at the cap it answers with its best result, so a research agent can not run forever. \`background: true\` returns { callId } at once; result({id: callId}) awaits the reply later. \`escalatable: true\` lets the agent ask for more budget at the cap instead of answering; the run then returns { requesting, reason, amount, handle }, and you decide with continue().`,
        input: {
          type: "object",
          properties: {
            text: { type: "string", description: "the brief" },
            background: { type: "boolean", description: "true: return { callId } at once, the reply arrives later via result()" },
            output: { description: "a declared contract's name, or a JSON schema for a structured answer" },
            model: { type: "string", enum: ["haiku", "sonnet", "opus"], description: "which model runs the agent; default sonnet" },
            budget: { type: "integer", description: "max tool calls before the agent must answer, a whole number of calls; keeps a research agent bounded" },
            escalatable: { type: "boolean", description: "true: at its budget the agent may ask for more instead of answering; the run returns a request you resolve with continue()" }
          },
          required: ["text"]
        },
        output: {
          type: "object",
          properties: {
            ...foregroundBoundarySchema.properties,
            dispatched: { type: "boolean" },
            callId: { type: "string" }
          }
        }
      },
      result: {
        description: "Await a run fired with `background: true`. Answers its terminal once the reply lands; parks the execution until then. An answer comes back parsed when that run declared a contract, which is read from the run itself.",
        input: {
          type: "object",
          properties: { id: { type: "string", description: "the callId a background run answered" } },
          required: ["id"]
        },
        output: {
          type: "object",
          properties: { output: {}, error: { type: "string" } }
        }
      },
      continue: {
        description: "Resolve a budget request from an escalatable run. Pass the request's `handle` and a `grant` of extra tool calls; a grant of 0 or less denies, and the agent finishes with what it has. A grant draws the run's shared budget, so a spent budget denies whatever you pass. Returns the agent's next boundary: another request, or its final answer, in the same shape run() returns.",
        input: {
          type: "object",
          properties: {
            handle: continuationHandleSchema,
            grant: { type: "integer", description: "extra tool calls to grant, a whole number of calls; 0 or less denies" }
          },
          required: ["handle", "grant"]
        },
        output: foregroundBoundarySchema
      }
    },
    methods: {
      run: (args, ctx) =>
        Effect.gen(function* () {
          // The three cross-lane privileges, read where the work happens: send, identity,
          // observe. A host that binds them serves this method; nothing here closes over one.
          const router = yield* Router
          const source = yield* Self
          const log = yield* EventLog
          const created = threadCreatedOf(yield* log.read)
          if (created === undefined) {
            return yield* Effect.die(new Error(`thread ${formatActorId(source)} cannot spawn without ThreadCreated`))
          }
          const lineage = childLineageOf(created)
          const self = formatActorId(source)
          const a = args as
            | { text?: unknown; background?: unknown; output?: unknown; outputSchema?: unknown; model?: unknown; budget?: unknown; escalatable?: unknown }
            | undefined
          const text = String(a?.text ?? "")
          if (text === "") return { error: "agents.run needs { text }" }
          // The contract parameter is `output`, and a near-miss spelling fails silently: no
          // contract means a prose answer, so the caller's field reads come back undefined and
          // the run returns something plausible and wrong. Say so instead.
          if (a?.output === undefined && a?.outputSchema !== undefined) {
            return { error: "agents.run takes the contract as `output`, not `outputSchema`" }
          }
          const declaredOutput = outputAsked(a?.output, outputs, declared_)
          if ("error" in declaredOutput) return declaredOutput
          const output = declaredOutput.contract
          const outputDeclaration = output === undefined ? undefined : { name: output.name, schema: output.schema }
          // The model name rides the brief's envelope: the child's log records the choice, so its
          // Infer resolves it from trajectory and replay agrees by construction.
          const model = a?.model === "haiku" || a?.model === "sonnet" || a?.model === "opus" ? a.model : undefined
          // asked is the tool-call budget carried on the brief. It accepts a whole positive count
          // because rounding could turn a requested child into an exhausted run (spawn.test.ts,
          // "a fractional budget"). An absent budget takes the per-agent default.
          const asked = a?.budget
          let want = defaultBudget
          if (asked !== undefined) {
            if (typeof asked !== "number" || !Number.isInteger(asked) || asked < 1) {
              return { error: `agents.run takes budget as a whole number of tool calls, at least 1; got ${JSON.stringify(asked)}` }
            }
            want = asked
          }
          // Draw from the run's single budget before the child spawns, so the whole tree is bounded by
          // it whatever the fan-out. A partial budget grants what is left; a spent budget grants 0, and
          // then no agent spawns, which is how the tree stops. The draw is keyed on this call's id, so
          // a re-driven code body reuses its grant and never draws twice.
          const budget = yield* Effect.promise(() => reserve(ctx.callId, want))
          if (budget <= 0) return { error: "the run's budget is exhausted; no budget to spawn this agent" }
          // The child works as the same member the parent does: the actor rides every brief in the
          // family, so a run's whole tree resolves connections identically.
          const actor = actorNameOf()
          // The parent's own shadow reading, never the tool args: an agent cannot set or unset it, so
          // a whole run family is shadow by construction from the fire alone. `world` rides along
          // the same way, when the fire named an explicit shared one.
          const shadow = shadowOf()
          const world = worldOf()
          const target = place(ctx.callId, source)
          const address = formatActorId(target)
          if (a?.background === true) {
            // A background run has no synchronous parent to decide an escalation, so it never asks:
            // the brief carries no `escalatable`, and the reply comes home as an inbound, awaited
            // later by `agents.result({ id: callId })`.
            const at = yield* Clock.currentTimeMillis
            yield* router.send(envelopeOf(linkOf(source, target), {
              type: "MessageReceived",
              id: ctx.callId,
              text,
              ...(outputDeclaration === undefined ? {} : { output: outputDeclaration }),
              ...(model === undefined ? {} : { model }),
              budget,
              ...(actor === undefined ? {} : { actor }),
              ...(shadow ? { shadow: true } : {}),
              ...(world === undefined ? {} : { world }),
              from: self,
              at
            }, lineage))
            return { dispatched: true, callId: ctx.callId }
          }
          // Foreground runs park on their next reported boundary. A replay reads that boundary
          // before redelivering the same brief.
          const already = yield* awaitedBoundary(source, ctx.callId, 0)
          if (already !== undefined) return shape(answerOf(already), address, ctx.callId, output)
          const at = yield* Clock.currentTimeMillis
          yield* router.send(envelopeOf(linkOf(source, target), {
            type: "MessageReceived",
            id: ctx.callId,
            text,
            ...(outputDeclaration === undefined ? {} : { output: outputDeclaration }),
            ...(model === undefined ? {} : { model }),
            budget,
            ...(a?.escalatable === true ? { escalatable: true } : {}),
            ...(actor === undefined ? {} : { actor }),
            ...(shadow ? { shadow: true } : {}),
            ...(world === undefined ? {} : { world }),
            from: self,
            at
          }, lineage))
          return yield* new Park({ callId: ctx.callId, awaiting: boundaryId(ctx.callId, 0) })
        }),
      // Await a run already fired in the background: no delivery, the same reply-or-park read the
      // plain foreground branch of `run` takes. `id` is the `callId` an earlier `background: true`
      // run answered.
      //
      // Whether that run declared a contract is recovered from the run's own recorded call, never
      // from an argument here: a later flag saying "this was structured" would let a caller parse
      // prose that happens to be JSON into a shape nobody asked the child for
      // (spawn.test.ts, "a later call cannot invent a contract the run never declared").
      //
      result: (args, ctx) =>
        Effect.gen(function* () {
          const source = yield* Self
          const a = args as { id?: unknown } | undefined
          const id = String(a?.id ?? "")
          if (id === "") return { error: "agents.result needs { id }" }
          // The child is where this package placed it, recomputed rather than taken from the
          // caller: `place` is the one owner of that answer (sibling above).
          const target = place(id, source)
          const address = formatActorId(target)
          const declared = yield* declaredRun(source, target, id)
          if ("error" in declared) return declared
          const reply = yield* awaitedBoundary(source, id, 0)
          if (reply !== undefined) return shape(answerOf(reply), address, id, declared.contract)
          return yield* new Park({ callId: ctx.callId, awaiting: boundaryId(id, 0) })
        }),
      // Continue a child parked on a budget ask. `grant` is the tool calls to add; a non-positive grant,
      // or a spent run budget, denies and the child finishes. The grant draws the run's budget like a
      // fresh spawn does, so escalation stays inside the same whole-run bound. Returns the child's next
      // boundary, another request or its final answer, in the same shape `run` returns.
      continue: (args, ctx) =>
        Effect.gen(function* () {
          const router = yield* Router
          const source = yield* Self
          const a = args as { handle?: unknown; grant?: unknown } | undefined
          const handle = a?.handle as { address?: unknown; turn?: unknown; round?: unknown; request?: unknown } | undefined
          const address = String(handle?.address ?? "")
          const turn = String(handle?.turn ?? "")
          const round = handle?.round
          const request = typeof handle?.request === "string" ? handle.request : ""
          if (address === "" || turn === "" || typeof round !== "number" || !Number.isSafeInteger(round) || round < 0 || request === "") {
            return { error: "agents.continue needs { handle, grant }; the handle comes from a run that is requesting" }
          }
          // grant accepts a whole count of calls because rounding could deny a request the parent
          // tried to grant (spawn.test.ts, "a fractional grant").
          const grant = a?.grant
          if (typeof grant !== "number" || !Number.isInteger(grant)) {
            return { error: `agents.continue takes grant as a whole number of tool calls; got ${JSON.stringify(grant)}` }
          }
          // The contract comes from the child's own brief, like `result`, so a rewritten handle
          // cannot make an answer structured that never was.
          const target = parseActorId(address)
          const declared = yield* declaredRun(source, target, turn)
          if ("error" in declared) return declared
          const already = yield* awaitedBoundary(source, turn, round + 1)
          if (already !== undefined) return shape(answerOf(already), address, turn, declared.contract)
          const granted = grant > 0 ? yield* Effect.promise(() => reserve(ctx.callId, grant)) : 0
          const at = yield* Clock.currentTimeMillis
          const decision = granted > 0
            ? budgetGranted({ amount: granted, callId: request, turn, at })
            : budgetDenied({ reason: "the parent declined the request", callId: request, turn, at })
          yield* router.send(envelopeOf(linkOf(source, target), decision))
          return yield* new Park({ callId: ctx.callId, awaiting: boundaryId(turn, round + 1) })
        })
    }
  })
}

// outputAsked resolves what a code body asked the child to answer in. A name is a contract the
// host declared, whose schema a TypeScript signature already checked. A schema object is the
// dynamic escape hatch: model-authored code carries no compile-time proof, so the schema is
// preflighted against the supported profile here, before the child is briefed and before any
// model is called (output.ts, outputProfileErrors). Anything else is an error the caller reads.
const outputAsked = (
  asked: unknown,
  outputs: Readonly<Record<string, OutputContract>>,
  declared: ReadonlyArray<string>
): { readonly contract: OutputContract | undefined } | { readonly error: string } => {
  if (asked === undefined) return { contract: undefined }
  if (typeof asked === "string") {
    const contract = outputs[asked]
    if (contract === undefined) {
      return {
        error:
          declared.length === 0
            ? `agents.run has no declared output contract named "${asked}"; this host declares none, so pass a JSON schema instead`
            : `agents.run has no declared output contract named "${asked}"; declared: ${declared.join(", ")}`
      }
    }
    return { contract }
  }
  if (asked === null || typeof asked !== "object") {
    return { error: "agents.run takes `output` as a declared contract's name or a JSON schema object" }
  }
  const built = outputFrom(INLINE_OUTPUT_NAME, asked)
  if ("errors" in built) {
    return {
      error: `the output schema is outside the supported profile:\n${built.errors.map((p) => `- ${p}`).join("\n")}`
    }
  }
  return { contract: built.contract }
}

// declaredRun recovers what one run asked its child to answer in. Two durable facts settle it,
// and neither is an argument a later call supplies.
//
// The run's own recorded call says whether structured output was asked for at all. The child's
// turn head says which contract, schema and all, so a name the code body used is resolved once,
// at the run, and never again: a registry entry that changes or disappears afterwards cannot
// re-read an old answer as a shape nobody asked for.
//
// A run that asked for structure whose declaration cannot be read fails closed. Returning the
// text would erase a contract that is known to exist merely because its terms are out of reach
// (spawn.test.ts, "a run stays bound to the schema it was started under").
const declaredRun = (
  self: ActorId,
  address: ActorId,
  turn: string
): Effect.Effect<{ readonly contract: OutputContract | undefined } | { readonly error: string }, never, Facets> =>
  Effect.gen(function* () {
    const logs = yield* Facets
    const here = yield* logs.read(self.thread)
    const call = here.find(
      (e) =>
        e.type === "PackageCalled" &&
        String((e as { callId?: unknown }).callId) === turn &&
        String((e as { name?: unknown }).name) === "agents.run"
    ) as { arguments?: { output?: unknown } } | undefined
    if (call === undefined) return { error: `no agents.run with id ${JSON.stringify(turn)} was called from here` }
    if (call.arguments?.output === undefined) return { contract: undefined }
    const child = yield* logs.read(address.thread)
    const declared = declarationForTurn(child, turn)
    if (declared.kind === "contract") return { contract: declared.contract }
    return {
      error:
        `the original output declaration for run ${JSON.stringify(turn)} is unavailable` +
        (declared.kind === "invalid" ? `: ${declared.errors.join("; ")}` : "")
    }
  })

// INLINE_OUTPUT_NAME is the schema identity an inline schema carries on the wire. Every declared
// contract names itself; an inline one has no name to carry, so the log and the provider both
// read this one and an operator can tell the two apart.
export const INLINE_OUTPUT_NAME = "inline"

// SpawnBoundary is one child boundary reported to its caller through the reversed accepted link.
interface SpawnBoundary {
  readonly outcome: "completed" | "failed" | "requesting"
  readonly text: string
  readonly reason?: string
  readonly amount?: number
  readonly round?: number
  readonly request?: string
}

// awaitedBoundary returns one reported boundary for a spawn, if it has landed on the calling lane. The
// read is the observe privilege (`Facets`), over this lane's own facet: `run` (awaiting) and
// `result` ask it whether a spawned child's reply is already home before ever parking. `id` is
// boundary id includes the escalation round, so each durable request or terminal has its own key.
const awaitedBoundary = (self: ActorId, turn: string, round: number): Effect.Effect<SpawnBoundary | undefined, never, Facets> =>
  Effect.gen(function* () {
    const logs = yield* Facets
    const events = yield* logs.read(self.thread)
    const reply = events.find(
      (e) => e.type === "MessageReceived" && (e as { id?: unknown }).id === boundaryId(turn, round)
    ) as { outcome?: unknown; text?: unknown; data?: unknown } | undefined
    if (reply === undefined) return undefined
    if (reply.outcome !== "requesting") {
      return { outcome: reply.outcome === "failed" ? "failed" : "completed", text: String(reply.text) }
    }
    const data = reply.data as { request?: unknown; reason?: unknown; amount?: unknown; round?: unknown } | undefined
    return {
      outcome: "requesting",
      text: String(reply.text),
      reason: String(data?.reason ?? reply.text ?? ""),
      amount: Number(data?.amount ?? 0),
      round: Number(data?.round ?? round),
      request: String(data?.request ?? "")
    }
  })

// answerOf strips a failed boundary's "error: " prefix back off, so a foreground
// body's `.error` reads the bare text while the fresh-inbound reading a background reply keeps
// the convention.
const ERROR_PREFIX = "error: "
const answerOf = (reply: SpawnBoundary): {
  readonly output?: string
  readonly error?: string
  readonly requesting?: boolean
  readonly reason?: string
  readonly amount?: number
  readonly round?: number
  readonly request?: string
} => {
  if (reply.outcome === "requesting") {
    return {
      requesting: true,
      ...(reply.reason === undefined ? {} : { reason: reply.reason }),
      ...(reply.amount === undefined ? {} : { amount: reply.amount }),
      ...(reply.round === undefined ? {} : { round: reply.round }),
      ...(reply.request === undefined ? {} : { request: reply.request })
    }
  }
  return reply.outcome === "completed"
    ? { output: reply.text }
    : { error: reply.text.startsWith(ERROR_PREFIX) ? reply.text.slice(ERROR_PREFIX.length) : reply.text }
}

// shape renders a boundary as the code's return value. A request carries a handle the code passes
// back to `agents.continue`; the handle names where and which turn, and nothing about the answer's
// shape, because the contract is recovered from the recorded call at every step (declaredRun).
//
// A terminal under a contract comes back decoded and validated. A terminal that misses the
// contract comes back as an error rather than as a value: the child's own reactor already refused
// such an answer, so one arriving here means the reply did not come from that path, and reading it
// as the contract's shape would be the reinterpretation this whole surface exists to prevent.
const shape = (
  answer: { output?: string; error?: string; requesting?: boolean; reason?: string; amount?: number; round?: number; request?: string },
  address: string,
  turn: string,
  contract: OutputContract | undefined
): unknown => {
  if (answer.requesting === true) {
    return {
      requesting: true,
      reason: answer.reason,
      amount: answer.amount,
      handle: { address, turn, round: answer.round, request: answer.request }
    }
  }
  if (contract === undefined || answer.output === undefined) return answer
  const decoded = decodeOutput(contract, answer.output)
  if (decoded.errors.length > 0) {
    return {
      error: `the run answered outside its declared contract "${contract.name}": ${decoded.errors.join("; ")}`
    }
  }
  return { output: decoded.value }
}
