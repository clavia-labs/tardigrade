import { Clock, Effect } from "effect"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { Self } from "@clavia/tardigrade-core/reconciliation"
import { EventLog } from "@clavia/tardigrade-core/log"
import { definePackage, type Package } from "@clavia/tardigrade-code/package/definition"
import { budgetPolicyOf, type BudgetPolicy } from "../components/budget"
import { Park } from "@clavia/tardigrade-code/execution/errors"
import { boundaryId } from "@clavia/tardigrade-core/communication/message"
import { linkOf } from "@clavia/tardigrade-core/communication/link"
import { methodEnvelopeOf } from "@clavia/tardigrade-core/communication/envelope"
import { childLineageOf, threadCreatedOf } from "@clavia/tardigrade-core/thread"
import {
  actorIdOf,
  formatActorId,
  type ActorId
} from "@clavia/tardigrade-core/communication/endpoint"
import { decodeOutput, outputFrom, type OutputContract } from "../output/contract"
import { modelRefOf, type ModelRef } from "../inference/reference"

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
// arguments. `Router` sends, `Self` names the calling lane, and `EventLog` supplies its durable
// calls, responses, and creation record.
//
// place selects the child's actor address from the call id and parent address. The host resolves
// that stable identity to current placement when it interprets the resulting link.
//
// A plain foreground run parks, the same mechanism `tasks.fire` (`src/packages/tasks.ts`) uses:
// deliver the brief through a link from this lane, then await the reply row on this lane, host-side
// `Park` when it has not landed yet (`src/code/execute.ts`'s proxy is what turns that into a promise
// that never settles for the code body). It never holds a call open.
//
// An escalatable run keeps the same call pending while the child negotiates through the parent's
// requestBudget method. The original call receives only the child's terminal response.

// SpawnOptions is the placement's environment: who the family works as, how a child's budget is
// drawn from the run, and the isolation labels a brief carries down. Every field has a default,
// and `budget` is one of them rather than a constant this module reads: a spawn with no stated
// budget takes the same ceiling the child's own reactor would, and a consumer that moved that
// ceiling moves both (budget.ts, BudgetPolicy).
export interface SpawnOptions {
  // The output contracts a spawning body may ask a child for, by name. Model-authored code has
  // no TypeScript checking (packages/code/src/execution/reactor.ts runs it through AsyncFunction), so a
  // name resolved here is the only path where the schema was proved at compile time by the host
  // that declared it. A raw schema stays reachable and is preflighted instead (spawn.test.ts,
  // "the output a spawn asks for").
  readonly outputs?: Readonly<Record<string, OutputContract>>
  // model is the fixed reference used by every child this package starts. An absent value leaves selection to the child actor's default.
  readonly model?: ModelRef
  readonly actorNameOf?: () => string | undefined
  readonly reserve?: (callId: string, want: number) => Promise<number>
  readonly shadowOf?: () => boolean
  // The parent's explicit world label, when its own fire named a shared world instead of taking
  // the anonymous one (docs/worlds.md). Forwarded onto every spawn's brief the same way `shadow`
  // is, so a whole family stays on one shared world's facets.
  readonly worldOf?: () => string | undefined
  readonly budget?: Partial<BudgetPolicy>
}

const foregroundBoundarySchema = {
  type: "object",
  properties: {
    output: {},
    error: { type: "string" }
  }
}

// sibling is the default placement: the child is a facet of the parent's own principal, named `ag.<callId>`. The address selects the target while ThreadCreated records its lineage (spawn.test.ts, "the default placement is the host's own sibling address"; tla/runtime/Thread.tla, CreationFirst).
const sibling = (callId: string, self: ActorId): ActorId =>
  actorIdOf(self.actor, `ag.${callId}`)

export const agentsPackage = (
  options: SpawnOptions & { readonly place?: (callId: string, self: ActorId) => ActorId } = {}
): Package<Router | Self | EventLog> => {
  const place = options.place ?? sibling
  const actorNameOf = options.actorNameOf ?? (() => undefined)
  const reserve = options.reserve ?? (async (_callId: string, want: number) => want)
  const shadowOf = options.shadowOf ?? (() => false)
  const worldOf = options.worldOf ?? (() => undefined)
  const defaultBudget = budgetPolicyOf(options.budget).limit
  const outputs = options.outputs ?? {}
  const model = options.model === undefined ? undefined : modelRefOf(options.model)
  if (options.model !== undefined && model === undefined) {
    throw new Error("agentsPackage model must be { provider, model_id }")
  }
  const declared_ = Object.keys(outputs)
  return definePackage({
    name: "agents",
    description: "Ad-hoc agents. run({text}) starts a fresh agent with the brief and waits for its terminal answer; add background: true for a long job, and result({id}) awaits the reply later. An escalatable child negotiates budget with its parent's requestBudget method while run remains pending.",
    annotations: {
      run: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      result: { readOnlyHint: true, openWorldHint: false }
    },
    docs: {
      run: {
        description: `Brief a fresh agent. \`output\` makes the result structured and parsed: the name of a declared contract${declared_.length === 0 ? " (this host declares none)" : ` (${declared_.join(", ")})`}, or a JSON schema of your own. \`budget\` caps the agent's tool calls: at the cap it answers with its best result, so a research agent can not run forever. \`background: true\` returns { callId } at once; result({id: callId}) awaits the reply later. \`escalatable: true\` lets the child call its parent's requestBudget method at the cap while this run remains pending for one terminal answer.`,
        input: {
          type: "object",
          properties: {
            text: { type: "string", description: "the brief" },
            background: { type: "boolean", description: "true: return { callId } at once, the reply arrives later via result()" },
            output: { description: "a declared contract's name, or a JSON schema for a structured answer" },
            budget: { type: "integer", description: "max tool calls before the agent must answer, a whole number of calls; keeps a research agent bounded" },
            escalatable: { type: "boolean", description: "true: at its budget the child may ask its parent's budget authority for more before answering" }
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
        description: "Await a run fired with `background: true`. Answers its terminal once the reply lands; parks the execution until then. An answer comes back parsed when the child accepted a contract with that call.",
        input: {
          type: "object",
          properties: { id: { type: "string", description: "the callId a background run answered" } },
          required: ["id"]
        },
        output: {
          type: "object",
          properties: { output: {}, error: { type: "string" } }
        }
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
          if (a?.model !== undefined) {
            return { error: "agents.run does not take model; configure agentsPackage({ model })" }
          }
          const declaredOutput = outputAsked(a?.output, outputs, declared_)
          if ("error" in declaredOutput) return declaredOutput
          const output = declaredOutput.contract
          const outputDeclaration = output === undefined ? undefined : { name: output.name, schema: output.schema }
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
          // family, so a run's whole tree resolves providers identically.
          const actor = actorNameOf()
          // The parent's own shadow reading, never the tool args: an agent cannot set or unset it, so
          // a whole run family is shadow by construction from the fire alone. `world` rides along
          // the same way, when the fire named an explicit shared one.
          const shadow = shadowOf()
          const world = worldOf()
          const target = place(ctx.callId, source)
          if (a?.background === true) {
            // A background run uses the same actor protocol. Its budget request can be served while
            // no code body awaits it, and its terminal is collected later by agents.result.
            const at = yield* Clock.currentTimeMillis
            yield* router.send(methodEnvelopeOf(linkOf(source, target), { method: "message", id: ctx.callId }, {
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
            return { dispatched: true, callId: ctx.callId }
          }
          // Foreground runs park on their terminal response. A replay reads that response
          // before redelivering the same brief.
          const already = yield* awaitedBoundary(ctx.callId)
          if (already !== undefined) return shape(answerOf(already), ctx.callId, output)
          const at = yield* Clock.currentTimeMillis
          yield* router.send(methodEnvelopeOf(linkOf(source, target), { method: "message", id: ctx.callId }, {
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
      // The method response carries the contract accepted with the original call. A later argument
      // cannot reinterpret prose that happens to be JSON as a shape nobody asked the child for
      // (spawn.test.ts, "a later call cannot invent a contract the run never declared").
      //
      result: (args, ctx) =>
        Effect.gen(function* () {
          const a = args as { id?: unknown } | undefined
          const id = String(a?.id ?? "")
          if (id === "") return { error: "agents.result needs { id }" }
          const reply = yield* awaitedBoundary(id)
          if (reply?.contractError !== undefined) return { error: reply.contractError }
          if (reply !== undefined) return shape(answerOf(reply), id, reply.contract)
          return yield* new Park({ callId: ctx.callId, awaiting: boundaryId(id, 0) })
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

// INLINE_OUTPUT_NAME is the schema identity an inline schema carries on the wire. Every declared
// contract names itself; an inline one has no name to carry, so the log and the provider both
// read this one and an operator can tell the two apart.
export const INLINE_OUTPUT_NAME = "inline"

// SpawnBoundary is one child terminal reported to its caller through the reversed accepted link.
interface SpawnBoundary {
  readonly outcome: "completed" | "failed"
  readonly text: string
  readonly contract?: OutputContract
  readonly contractError?: string
}

const contractOf = (
  data: unknown,
  turn: string
): { readonly contract?: OutputContract; readonly contractError?: string } => {
  if (typeof data !== "object" || data === null || !("output" in data)) return {}
  const declaration = (data as { readonly output?: unknown }).output
  if (typeof declaration !== "object" || declaration === null) {
    return { contractError: `the original output declaration for run ${JSON.stringify(turn)} is unavailable` }
  }
  const carried = declaration as { readonly name?: unknown; readonly schema?: unknown }
  const built = outputFrom(carried.name, carried.schema)
  return "errors" in built
    ? { contractError: `the original output declaration for run ${JSON.stringify(turn)} is unavailable: ${built.errors.join("; ")}` }
    : { contract: built.contract }
}

// awaitedBoundary reads a child method response from the caller's own private log.
const awaitedBoundary = (turn: string): Effect.Effect<SpawnBoundary | undefined, never, EventLog> =>
  Effect.gen(function* () {
    const log = yield* EventLog
    const events = yield* log.read
    const response = events.find(
      (event) => event.type === "ResponseReceived" &&
        (event as { readonly id?: unknown }).id === boundaryId(turn, 0)
    ) as {
      readonly status?: unknown
      readonly output?: unknown
      readonly error?: unknown
      readonly data?: unknown
    } | undefined
    if (response !== undefined) {
      const contract = contractOf(response.data, turn)
      if (response.status === "completed") return { outcome: "completed", text: String(response.output), ...contract }
      if (response.status === "failed") return { outcome: "failed", text: `error: ${String(response.error)}`, ...contract }
      return undefined
    }
    return undefined
  })

// answerOf strips a failed boundary's "error: " prefix back off, so a foreground
// body's `.error` reads the bare text while the fresh-inbound reading a background reply keeps
// the convention.
const ERROR_PREFIX = "error: "
const answerOf = (reply: SpawnBoundary): {
  readonly output?: string
  readonly error?: string
} => {
  return reply.outcome === "completed"
    ? { output: reply.text }
    : { error: reply.text.startsWith(ERROR_PREFIX) ? reply.text.slice(ERROR_PREFIX.length) : reply.text }
}

// shape renders a terminal as the code's return value.
// A terminal under a contract comes back decoded and validated. A terminal that misses the
// contract comes back as an error rather than as a value: the child's own reactor already refused
// such an answer, so one arriving here means the reply did not come from that path, and reading it
// as the contract's shape would be the reinterpretation this whole surface exists to prevent.
const shape = (
  answer: { output?: string; error?: string },
  turn: string,
  contract: OutputContract | undefined
): unknown => {
  if (contract === undefined || answer.output === undefined) return answer
  const decoded = decodeOutput(contract, answer.output)
  if (decoded.errors.length > 0) {
    return {
      error: `the run answered outside its declared contract "${contract.name}": ${decoded.errors.join("; ")}`
    }
  }
  return { output: decoded.value }
}
