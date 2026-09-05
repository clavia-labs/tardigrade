import { Clock, Effect, Schema } from "effect"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { Self } from "@clavia/tardigrade-core/runtime"
import {
  invocationLinked,
  type ActorInvocationContext
} from "@clavia/tardigrade-core/actor"
import { EventLog } from "@clavia/tardigrade-core/log"
import type { ResponseReceived } from "@clavia/tardigrade-core/method"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { definePackage, type Package } from "@clavia/tardigrade-code/package/definition"
import { eventEpochOf, turnOf, turnView } from "@clavia/tardigrade-code/execution/turns"
import { budgetPolicyOf, type BudgetPolicy } from "../component/budget"
import { Park } from "@clavia/tardigrade-code/execution/errors"
import { boundaryId } from "@clavia/tardigrade-core/communication/message"
import { linkOf } from "@clavia/tardigrade-core/communication/link"
import { methodEnvelopeOf } from "@clavia/tardigrade-core/communication/envelope"
import {
  ChildCreated,
  childCreated,
  childLineageOf,
  ChildPlacement,
  threadCreatedOf,
  type ThreadCreated,
  type ThreadLineage
} from "@clavia/tardigrade-core/thread"
import {
  threadAddressOf,
  formatThreadAddress,
  type ThreadAddress
} from "@clavia/tardigrade-core/communication/endpoint"
import { decodeOutput, outputFrom, type OutputContract } from "../output/contract"
import { modelRefOf } from "../inference/reference"
import {
  applyModelPolicy,
  DEFAULT_MODEL_POLICY,
  modelAllowedBy,
  modelPolicyOf,
  modelPolicyOverrideOf,
  type ModelPolicy,
  type ModelPolicyOverride
} from "../inference/access"

// agentsPackage provides model discovery and ad-hoc agents. A background run returns an opaque
// handle which names the exact parent-turn/call spawn; agents.result awaits that handle.
//
// Every call is its own agent. A call id is unique only within its parent turn, so the child
// method identity and thread name use the injective pair. Background changes response waiting,
// not ownership: explicit and deadline cancellation still cascade through its durable link.
//
// The package is a value any consumer mounts: its host privileges are services, not constructor
// arguments. `Router` sends, `Self` names the calling thread, and `EventLog` supplies its durable
// calls, responses, and creation record.
//
// A plain foreground run parks, the same mechanism `tasks.fire` (`src/packages/tasks.ts`) uses:
// deliver the brief through a link from this thread, then await the reply row on this thread, host-side
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
  // catalog supplies provider and model discovery to the package.
  readonly catalog?: AgentCatalog
  // models narrows inherited authority and may select a default for children started by this package.
  readonly models?: ModelPolicyOverride
  readonly actorNameOf?: () => string | undefined
  readonly reserve?: (callId: string, want: number) => Promise<number>
  readonly shadowOf?: () => boolean
  // The parent's explicit world label, when its own fire named a shared world instead of taking
  // the anonymous one (docs/worlds.md). Forwarded onto every spawn's brief the same way `shadow`
  // is, so a whole family stays on one shared world's facets.
  readonly worldOf?: () => string | undefined
  readonly budget?: Partial<BudgetPolicy>
}

// AgentCatalogQuery selects a page of providers from the model catalog.
export interface AgentCatalogQuery {
  readonly availability?: "available"
  readonly models?: ModelPolicy
  readonly cursor?: string
  readonly search?: string
  readonly limit?: number
}

// AgentModelCatalogQuery selects a page of models from the model catalog.
export interface AgentModelCatalogQuery extends AgentCatalogQuery {
  readonly provider?: string
  readonly sort?: "promptUsdPerToken" | "completionUsdPerToken" | "cachedPromptUsdPerToken" | "cacheWritePromptUsdPerToken"
  readonly order?: "asc" | "desc"
  readonly unpriced?: "first" | "last"
}

// AgentCatalog serves provider and model discovery pages.
export interface AgentCatalog {
  readonly providers: (query: AgentCatalogQuery) => unknown
  readonly models: (query: AgentModelCatalogQuery) => unknown
}

const foregroundBoundarySchema = {
  type: "object",
  properties: {
    output: {},
    error: { type: "string" }
  }
}

const catalogQueryProperties = {
  cursor: { type: "string", description: "the next_cursor returned by the previous page" },
  search: { type: "string", description: "case-insensitive text matched against IDs and names" },
  limit: { type: "integer", minimum: 1, description: "maximum items returned on this page" }
}

const catalogPageProperties = {
  revision: { type: "string" },
  status: { type: "string", enum: ["fresh", "cached"] },
  refreshed_at: { type: "number" },
  policy: {
    type: "object",
    properties: {
      default: {
        type: "object",
        properties: { provider: { type: "string" }, model_id: { type: "string" } },
        required: ["provider", "model_id"],
        additionalProperties: false
      },
      allow: {
        oneOf: [
          { const: "*" },
          {
            type: "array",
            items: {
              type: "object",
              properties: {
                provider: { type: "string" },
                model_ids: { oneOf: [{ const: "*" }, { type: "array", items: { type: "string" } }] }
              },
              required: ["provider", "model_ids"],
              additionalProperties: false
            }
          }
        ]
      }
    },
    required: ["allow"],
    additionalProperties: false
  },
  total: { type: "integer" },
  limit: { type: "integer" },
  next_cursor: { type: "string" }
}

const providerPageSchema = {
  type: "object",
  properties: {
    ...catalogPageProperties,
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          availability: {
            oneOf: [
              {
                type: "object",
                properties: { status: { const: "available" } },
                required: ["status"]
              },
              {
                type: "object",
                properties: {
                  status: { const: "unavailable" },
                  reason: { type: "string", enum: ["not_configured", "credential_missing"] }
                },
                required: ["status", "reason"]
              }
            ]
          },
          protocol: { type: "string" },
          baseUrl: { type: "string" },
          env: { type: "array", items: { type: "string" } },
          required: { type: "array", items: { type: "string" } },
          optional: { type: "array", items: { type: "string" } }
        },
        required: ["id", "name", "availability", "env", "required", "optional"]
      }
    },
    error: { type: "string" }
  }
}

const modelPageSchema = {
  type: "object",
  properties: {
    ...catalogPageProperties,
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          provider: { type: "string" },
          id: { type: "string" },
          name: { type: "string" },
          metadata: {
            type: "object",
            properties: {
              contextWindowTokens: { type: "integer" },
              maxOutputTokens: { type: "integer" },
              pricing: {
                type: "object",
                properties: {
                  promptUsdPerToken: { type: "number" },
                  completionUsdPerToken: { type: "number" },
                  cachedPromptUsdPerToken: { type: "number" },
                  cacheWritePromptUsdPerToken: { type: "number" }
                }
              },
              toolCall: { type: "boolean" },
              structuredOutput: { type: "boolean" },
              inputModalities: { type: "array", items: { type: "string" } },
              outputModalities: { type: "array", items: { type: "string" } }
            }
          }
        },
        required: ["provider", "id", "metadata"]
      }
    },
    error: { type: "string" }
  }
}

const catalogQueryOf = (args: unknown): AgentCatalogQuery => {
  const value = args as { readonly cursor?: unknown; readonly search?: unknown; readonly limit?: unknown } | undefined
  return {
    ...(typeof value?.cursor === "string" ? { cursor: value.cursor } : {}),
    ...(typeof value?.search === "string" ? { search: value.search } : {}),
    ...(typeof value?.limit === "number" ? { limit: value.limit } : {})
  }
}

// childInvocationId names one child method invocation and thread after its parent run and call.
// Length-prefixing keeps the pair injective even when either identifier has punctuation, so two
// turns reusing one call id name two children (agents.test.ts, "reused call ids across turns
// address distinct children").
export const childInvocationId = (parentRunId: string, callId: string): string =>
  `${parentRunId.length}:${parentRunId}${callId}`

// sibling is the default address: the child inherits the parent's actor instance and a thread
// name derived from the parent run and call. Thread placement remains a separate host decision
// (agents.test.ts, "the default address is the host's own sibling").
const sibling = (parentRunId: string, callId: string, self: ThreadAddress): ThreadAddress =>
  threadAddressOf(self.actor, self.instance, `ag.${childInvocationId(parentRunId, callId)}`)

// parentRunOf resolves the run a package call serves: its turn id and execution epoch. A call
// outside any run has no child to name, so the dispatch dies rather than guessing.
const parentRunOf = (call: Event): { readonly turn: string; readonly epoch: number } | undefined => {
  const turn = turnOf(call)
  return turn === undefined ? undefined : { turn, epoch: eventEpochOf(call) }
}

// childClaimOf resolves the child this dispatch owns. The recorded child is the ChildCreated
// between this call's PackageCalled in the parent run and the next call reusing the id, so a
// later turn reusing the id can never claim an earlier turn's child, and a replay reads its
// own dispatch's record (agents.test.ts, "reused call ids across turns address distinct
// children").
const childClaimOf = (
  placement: unknown,
  events: ReadonlyArray<Event>,
  parent: ThreadCreated,
  parentRunId: string,
  callId: string,
  source: ThreadAddress
) => {
  if (placement !== undefined && !Schema.is(ChildPlacement)(placement)) {
    return { error: "agents.run placement must be colocated or independent" }
  }
  const sent = events.findLastIndex((event) =>
    event.type === "PackageCalled" &&
    event.callId === callId &&
    turnOf(event) === parentRunId)
  const next = events.findIndex((event, index) =>
    index > sent &&
    event.type === "PackageCalled" &&
    event.callId === callId)
  const recorded = sent < 0
    ? undefined
    : events.slice(sent + 1, next < 0 ? undefined : next).find(
        (event) => event.type === "ChildCreated" && event.callId === callId
      )
  if (recorded !== undefined && !Schema.is(ChildCreated)(recorded)) {
    throw new Error(`child ${callId} has an invalid creation record`)
  }
  const lineage: ThreadLineage = recorded === undefined
    ? childLineageOf(parent, placement as ChildPlacement | undefined)
    : {
        parent: parent.address,
        depth: recorded.depth,
        ...(recorded.placement === undefined ? {} : { placement: recorded.placement })
      }
  const target = recorded?.address ?? sibling(parentRunId, callId, source)
  // A legacy call id names its child ag.<callId>, so the length-prefixed scheme can derive the
  // same address for a different dispatch (agents.test.ts, "a derived address that names another
  // child dies rather than delivering"). No in-band marker separates the schemes, so the
  // collision dies instead of delivering the brief to the child another dispatch owns.
  if (recorded === undefined) {
    const clash = events.find(
      (event): event is ChildCreated =>
        Schema.is(ChildCreated)(event) &&
        event.address.actor === target.actor &&
        event.address.instance === target.instance &&
        event.address.thread === target.thread &&
        (event.callId !== callId || event.turn === undefined)
    )
    if (clash !== undefined) {
      throw new Error(
        `agents.run ${callId} derives child address ${formatThreadAddress(target)}, which child ${clash.callId} already owns`
      )
    }
  }
  return { recorded, target, lineage }
}

const inheritedModelsOf = (events: ReadonlyArray<Event>): ModelPolicy => {
  const head = turnView(events)[0] as { readonly models?: unknown } | undefined
  return head?.models === undefined ? DEFAULT_MODEL_POLICY : modelPolicyOf(head.models)
}

export const agentsPackage = (options: SpawnOptions = {}): Package<Router | Self | EventLog> => {
  const actorNameOf = options.actorNameOf ?? (() => undefined)
  const reserve = options.reserve ?? (async (_callId: string, want: number) => want)
  const shadowOf = options.shadowOf ?? (() => false)
  const worldOf = options.worldOf ?? (() => undefined)
  const defaultBudget = budgetPolicyOf(options.budget).limit
  const outputs = options.outputs ?? {}
  const catalog = options.catalog
  const packageModels = modelPolicyOverrideOf(options.models)
  const effectiveModelsOf = (events: ReadonlyArray<Event>): ModelPolicy =>
    applyModelPolicy(inheritedModelsOf(events), packageModels)
  const effectiveModelsResultOf = (events: ReadonlyArray<Event>):
    | { readonly models: ModelPolicy }
    | { readonly error: string } => {
    try {
      return { models: effectiveModelsOf(events) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  const declared_ = Object.keys(outputs)
  return definePackage({
    name: "agents",
    description: "Search known providers and available models, and run ad-hoc agents. providers() lists provider configuration requirements and availability. models() lists models from available providers with metadata and pricing; use provider to limit the search and sort to order a pricing field. run({text}) starts a fresh agent with the brief and waits for its terminal answer; add background: true for a long job, and result({id}) awaits the reply later. An escalatable child negotiates budget with its parent's requestBudget method while run remains pending.",
    annotations: {
      providers: { readOnlyHint: true, openWorldHint: false },
      models: { readOnlyHint: true, openWorldHint: false },
      run: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      result: { readOnlyHint: true, openWorldHint: false }
    },
    docs: {
      providers: {
        description: "Search providers this agent may use. The page carries the effective model policy, including its default, plus connection requirements and no credential values.",
        input: { type: "object", properties: catalogQueryProperties },
        output: providerPageSchema
      },
      models: {
        description: "Search models from available providers. The page carries the effective model policy, including its default. Set provider to search models within one provider. Each item carries metadata and pricing.",
        input: {
          type: "object",
          properties: {
            ...catalogQueryProperties,
            provider: { type: "string", description: "exact provider ID" },
            sort: {
              type: "string",
              enum: ["promptUsdPerToken", "completionUsdPerToken", "cachedPromptUsdPerToken", "cacheWritePromptUsdPerToken"],
              description: "pricing field used to order models"
            },
            order: { type: "string", enum: ["asc", "desc"], description: "price order; defaults to asc" },
            unpriced: { type: "string", enum: ["first", "last"], description: "placement of models without the selected price; defaults to last" }
          }
        },
        output: modelPageSchema
      },
      run: {
        description: `Brief a fresh agent. \`output\` makes the result structured and parsed: the name of a declared contract${declared_.length === 0 ? " (this host declares none)" : ` (${declared_.join(", ")})`}, or a JSON schema of your own. \`model\` selects one configured provider and model for this child. \`budget\` caps the agent's tool calls: at the cap it answers with its best result, so a research agent can not run forever. \`background: true\` returns { callId, handle }; retain the opaque handle and pass it unchanged to result({handle}).`,
        input: {
          type: "object",
          properties: {
            text: { type: "string", description: "the brief" },
            background: { type: "boolean", description: "true: return { callId, handle } at once; pass handle unchanged to result()" },
            output: { description: "a declared contract's name, or a JSON schema for a structured answer" },
            model: {
              type: "object",
              description: "the configured provider and provider-specific model ID",
              properties: {
                provider: { type: "string" },
                model_id: { type: "string" }
              },
              required: ["provider", "model_id"],
              additionalProperties: false
            },
            budget: { type: "integer", description: "max tool calls before the agent must answer, a whole number of calls; keeps a research agent bounded" },
            placement: { type: "string", enum: ["colocated", "independent"], description: "place the child relative to this thread's host" },
            escalatable: { type: "boolean", description: "true: at its budget the child may ask its parent's budget authority for more before answering" }
          },
          required: ["text"]
        },
        output: {
          type: "object",
          properties: {
            ...foregroundBoundarySchema.properties,
            dispatched: { type: "boolean" },
            callId: { type: "string" },
            handle: { type: "string" }
          }
        }
      },
      result: {
        description: "Await the exact run represented by the opaque handle returned from a background run.",
        input: {
          type: "object",
          properties: { handle: { type: "string", description: "opaque handle returned by a background run" } },
          required: ["handle"]
        },
        output: {
          type: "object",
          properties: { output: {}, error: { type: "string" } }
        }
      }
    },
    methods: {
      providers: (args) => Effect.gen(function* () {
        if (catalog === undefined) return { error: "model catalog is unavailable" }
        const log = yield* EventLog
        const resolved = effectiveModelsResultOf(yield* log.read)
        return "error" in resolved
          ? resolved
          : catalog.providers({ ...catalogQueryOf(args), availability: "available", models: resolved.models })
      }),
      models: (args) => Effect.gen(function* () {
        if (catalog === undefined) return { error: "model catalog is unavailable" }
        const log = yield* EventLog
        const resolved = effectiveModelsResultOf(yield* log.read)
        if ("error" in resolved) return resolved
        const models = resolved.models
        const query = catalogQueryOf(args)
        const value = args as {
          readonly provider?: unknown
          readonly sort?: unknown
          readonly order?: unknown
          readonly unpriced?: unknown
        } | undefined
        const sort = value?.sort
        const order = value?.order
        const unpriced = value?.unpriced
        return catalog.models({
          ...query,
          availability: "available",
          models,
          ...(typeof value?.provider === "string" ? { provider: value.provider } : {}),
          ...(typeof sort === "string" ? { sort: sort as Exclude<AgentModelCatalogQuery["sort"], undefined> } : {}),
          ...(typeof order === "string" ? { order: order as Exclude<AgentModelCatalogQuery["order"], undefined> } : {}),
          ...(typeof unpriced === "string" ? { unpriced: unpriced as Exclude<AgentModelCatalogQuery["unpriced"], undefined> } : {})
        })
      }),
      run: (args, ctx) =>
        Effect.gen(function* () {
          // The three cross-thread privileges, read where the work happens: send, identity,
          // observe. A host that binds them serves this method; nothing here closes over one.
          const router = yield* Router
          const source = yield* Self
          const log = yield* EventLog
          const events = yield* log.read
          const created = threadCreatedOf(events)
          if (created === undefined) {
            return yield* Effect.die(new Error(`thread ${formatThreadAddress(source)} cannot spawn without ThreadCreated`))
          }
          const self = formatThreadAddress(source)
          const a = args as
            | { text?: unknown; background?: unknown; output?: unknown; outputSchema?: unknown; model?: unknown; budget?: unknown; escalatable?: unknown; placement?: unknown }
            | undefined
          const text = String(a?.text ?? "")
          if (text === "") return { error: "agents.run needs { text }" }
          const call = turnView(events).find((event) =>
            event.type === "PackageCalled" && event.callId === ctx.callId
          )
          const parentRun = call === undefined ? undefined : parentRunOf(call)
          if (parentRun === undefined) {
            return yield* Effect.die(new Error(`agents.run ${ctx.callId} has no parent turn`))
          }
          const invocationId = childInvocationId(parentRun.turn, ctx.callId)
          const child = childClaimOf(a?.placement, events, created, parentRun.turn, ctx.callId, source)
          if ("error" in child) return child
          const { lineage, recorded: recordedChild, target } = child
          // The contract parameter is `output`, and a near-miss spelling fails silently: no
          // contract means a prose answer, so the caller's field reads come back undefined and
          // the run returns something plausible and wrong. Say so instead.
          if (a?.output === undefined && a?.outputSchema !== undefined) {
            return { error: "agents.run takes the contract as `output`, not `outputSchema`" }
          }
          const resolved = effectiveModelsResultOf(events)
          if ("error" in resolved) return resolved
          const models = resolved.models
          const selectedModel = a?.model === undefined ? models.default : modelRefOf(a.model)
          if (a?.model !== undefined && selectedModel === undefined) return { error: "agents.run model must be { provider, model_id }" }
          if (selectedModel !== undefined && !modelAllowedBy(models, selectedModel)) {
            return { error: `agents.run model ${selectedModel.provider}/${selectedModel.model_id} is excluded by the effective model policy` }
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
          // A background child has no response parent, but remains linked to the owning
          // invocation so explicit and deadline cancellation cascade through the whole family.
          const owner = { method: "message", id: parentRun.turn, epoch: parentRun.epoch }
          const responseParent = a?.background === true ? undefined : owner
          const spawningMessage = events.find(
            (event) => event.type === "MessageReceived" && event.id === parentRun.turn
          )
          const parentDeadline = events.find((event) => {
            const context = (event as { readonly call?: unknown }).call as Partial<ActorInvocationContext> | undefined
            return context?.invocation !== undefined &&
              context.invocation.method === owner.method &&
              context.invocation.id === owner.id &&
              context.invocation.epoch === owner.epoch
          }) as ({ readonly call?: ActorInvocationContext } & Event) | undefined
          const childContext: ActorInvocationContext = {
            invocation: { method: "message", id: invocationId, epoch: 0 },
            ...(responseParent === undefined ? {} : { parent: responseParent }),
            ...(parentDeadline?.call?.deadlineAt === undefined ? {} : { deadlineAt: parentDeadline.call.deadlineAt })
          }
          const dispatch = (at: number) => Effect.gen(function* () {
            const linked = [
              invocationLinked({ parent: owner, child: childContext, target: formatThreadAddress(target), lineage, at })
            ]
            if (recordedChild === undefined || linked.length > 0) {
              yield* log.append([
                ...(recordedChild === undefined ? [childCreated(ctx.callId, target, lineage, at, parentRun.turn)] : []),
                ...linked
              ])
            }
            yield* router.send(methodEnvelopeOf(linkOf(source, target), childContext, {
              type: "MessageReceived",
              id: invocationId,
              text,
              input: spawningMessage?.input,
              ...(outputDeclaration === undefined ? {} : { output: outputDeclaration }),
              ...(selectedModel === undefined ? {} : { model: selectedModel }),
              models,
              budget,
              ...(a?.escalatable === true ? { escalatable: true } : {}),
              ...(actor === undefined ? {} : { actor }),
              ...(shadow ? { shadow: true } : {}),
              ...(world === undefined ? {} : { world }),
              from: self,
              at
            }, lineage))
          })
          if (a?.background === true) {
            // A background run uses the same actor protocol. Its budget request can be served while
            // no code body awaits it, and its terminal is collected later by agents.result.
            const at = yield* Clock.currentTimeMillis
            yield* dispatch(at)
            return { dispatched: true, callId: ctx.callId, handle: invocationId }
          }
          // Foreground runs park on their terminal response. A replay reads that response
          // before redelivering the same brief.
          const already = yield* awaitedBoundary(invocationId)
          if (already !== undefined) return shape(answerOf(already), ctx.callId, output)
          const at = yield* Clock.currentTimeMillis
          yield* dispatch(at)
          return yield* new Park({ callId: ctx.callId, awaiting: boundaryId(invocationId, 0) })
        }),
      // Await a background run by its opaque, turn-scoped child invocation identity.
      //
      // The method response carries the contract accepted with the original call. A later argument
      // cannot reinterpret prose that happens to be JSON as a shape nobody asked the child for
      // (spawn.test.ts, "a later call cannot invent a contract the run never declared").
      //
      result: (args, ctx) =>
        Effect.gen(function* () {
          const a = args as { handle?: unknown } | undefined
          const handle = String(a?.handle ?? "")
          if (handle === "") return { error: "agents.result needs { handle } from a background run" }
          const reply = yield* awaitedBoundary(handle)
          if (reply?.contractError !== undefined) return { error: reply.contractError }
          if (reply !== undefined) return shape(answerOf(reply), handle, reply.contract)
          return yield* new Park({ callId: ctx.callId, awaiting: boundaryId(handle, 0) })
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

interface SpawnBoundaryContext {
  readonly contract?: OutputContract
  readonly contractError?: string
}

// SpawnBoundary is one child terminal reported to its caller through the reversed accepted link.
type SpawnBoundary = SpawnBoundaryContext & (
  | { readonly outcome: "completed"; readonly text: string }
  | { readonly outcome: "failed"; readonly text: string }
  | {
      readonly outcome: "cancelled"
      readonly cause: "requested" | "deadline"
      readonly reason?: string
      readonly deadlineAt?: number
    }
)

const contractOf = (
  data: unknown,
  turn: string
): SpawnBoundaryContext => {
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

// awaitedBoundaryOf projects one child response from the caller's private log. A cancelled response remains structured and settles the wait (agents.test.ts, "a cancelled reply settles the run as a failed answer", "a cancelled reply with no reason settles as a bare cancelled error"). A delivered method response is a ResponseReceived carrying the round-zero boundary id (response.test.ts, "returns a terminal through the accepted call link").
export const awaitedBoundaryOf = (events: ReadonlyArray<Event>, turn: string): SpawnBoundary | undefined => {
  const response = events.find(
    (event) => event.type === "ResponseReceived" && event.id === boundaryId(turn, 0)
  ) as ResponseReceived | undefined
  if (response === undefined) return undefined
  const contract = contractOf(response.data, turn)
  if (response.status === "completed") return { outcome: "completed", text: String(response.output), ...contract }
  if (response.status === "failed") return { outcome: "failed", text: `error: ${String(response.error)}`, ...contract }
  return {
    outcome: "cancelled",
    cause: response.cause === "deadline" ? "deadline" : "requested",
    ...(typeof response.reason === "string" && response.reason !== "" ? { reason: response.reason } : {}),
    ...(typeof response.deadlineAt === "number" ? { deadlineAt: response.deadlineAt } : {}),
    ...contract
  }
}

// awaitedBoundary reads a child method response from the caller's own private log.
const awaitedBoundary = (turn: string): Effect.Effect<SpawnBoundary | undefined, never, EventLog> =>
  Effect.gen(function* () {
    const log = yield* EventLog
    return awaitedBoundaryOf(yield* log.read, turn)
  })

// answerOf maps a child terminal to the package's public result. Cancellation metadata remains on SpawnBoundary while callers keep the existing error result (agents.test.ts, "a cancelled reply settles the run as a failed answer").
const ERROR_PREFIX = "error: "
const answerOf = (reply: SpawnBoundary): {
  readonly output?: string
  readonly error?: string
} => {
  if (reply.outcome === "cancelled") {
    const reason = reply.reason === undefined ? "" : `: ${reply.reason}`
    return { error: `cancelled${reason}` }
  }
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
