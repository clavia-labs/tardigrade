import { OperationScope } from "@clavia/tardigrade-core/runtime/context"
import { Clock, Effect, Schema } from "effect"
import { Router } from "@clavia/tardigrade-core/transport/router"
import { Self } from "@clavia/tardigrade-core/runtime"
import { type ActorInvocationContext } from "@clavia/tardigrade-core/interaction/invocation"
import { EventLog } from "@clavia/tardigrade-core/log"
import { type ActorMethodState } from "@clavia/tardigrade-core/interaction/state"
import { InvocationCoordinate, invocationCoordinateOf, invocationCoordinateJsonSchema, invocationLinked, invocationCoordinateKey, invocationResponseId, invocationTerminalOf, invocationResultOf, prepareInvocation, sendInvocation } from "@clavia/tardigrade-core/interaction"
import { agentMessageMethod } from "../actor/message"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { definePackage, type Package } from "@clavia/tardigrade-code/package/definition"
import { eventEpochOf, turnOf, turnView } from "@clavia/tardigrade-code/execution/turns"
import { budgetPolicyOf, type BudgetPolicy } from "../component/budget"
import { Park } from "@clavia/tardigrade-code/execution/errors"
import { childInvocationRef } from "./agents-compat"
import { ChildCreated, childCreated, childLineageOf, threadCreatedOf, type ThreadCreated, type ThreadLineage } from "@clavia/tardigrade-core/interaction/relations"
import { childKeyOf } from "@clavia/tardigrade-core/actor/coordinate"
import { allocateChildCoordinate as allocateChildThread, ThreadAllocator } from "@clavia/tardigrade-core/actor/allocation"
import { ACTOR_METHOD_NAME_PATTERN, type ActorMethodDeclaration } from "@clavia/tardigrade-core/actor/method"
import {
  formatThreadAddress,
  type ThreadAddress
} from "@clavia/tardigrade-core/transport/endpoint"
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

// DEFAULT_MAX_DEPTH limits delegation to five edges from the root unless configured or inherited (agents.test.ts).
export const DEFAULT_MAX_DEPTH = 5

export interface ChildInitializationContext {
  readonly parent: ThreadAddress
  readonly child: InvocationCoordinate
  readonly parentInvocation: { readonly method: string; readonly id: string; readonly epoch: number }
  readonly callId: string
  readonly text: string
  readonly parentInput?: unknown
}

export interface ChildInitializer {
  readonly methodName: string
  readonly method: ActorMethodDeclaration
  readonly invocationId?: (context: ChildInitializationContext) => string
  readonly input: (context: ChildInitializationContext) => unknown | Promise<unknown>
}

// SpawnOptions configures child budgets, model access, output contracts, and inherited metadata.
export interface SpawnOptions {
  // maxDepth sets the deepest permitted child depth, with the root at zero (e2e/actor/mortyplicity.test.ts). An inherited ceiling can only be tightened; omission uses the inherited ceiling or DEFAULT_MAX_DEPTH.
  readonly maxDepth?: number | undefined
  // outputs supplies named output contracts available to child runs.
  readonly outputs?: Readonly<Record<string, OutputContract>>
  // catalog supplies provider and model discovery to the package.
  readonly catalog?: AgentCatalog
  // models narrows inherited authority and may select a default for children started by this package.
  readonly models?: ModelPolicyOverride
  readonly actorNameOf?: () => string | undefined
  // reserve grants a child budget; implementations must reuse grants for replayed call IDs.
  readonly reserve?: (callId: string, want: number) => Promise<number>
  readonly shadowOf?: () => boolean
  // worldOf supplies the world label forwarded to child briefs.
  readonly worldOf?: () => string | undefined
  // initializeChild gates first child delivery on one durable initializer invocation.
  readonly initializeChild?: ChildInitializer
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

// parentRunOf returns the package call's owning turn and execution epoch, if present.
const parentRunOf = (call: Event): { readonly turn: string; readonly epoch: number } | undefined => {
  const turn = turnOf(call)
  return turn === undefined ? undefined : { turn, epoch: eventEpochOf(call) }
}

const messageInputOf = (event: Event, id: string): unknown =>
  event.type === "MessageReceived" && "id" in event && String(event.id) === id && "input" in event
    ? event.input
    : undefined

// childClaimOf scopes a child to its parent turn and call, preserving recorded addresses on replay (agents.test.ts).
const childClaimOf = (
  events: ReadonlyArray<Event>,
  parent: ThreadCreated,
  parentRunId: string,
  callId: string,
  source: ThreadAddress,
  maxDepth: number | undefined,
  name: string | undefined
) => Effect.gen(function* () {
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
  const attemptedDepth = parent.depth + 1
  if (recorded === undefined && maxDepth !== undefined && attemptedDepth > maxDepth) {
    return { error: `agents.run cannot spawn at depth ${attemptedDepth}; maxDepth is ${maxDepth}`, maxDepth, attemptedDepth }
  }
  if (recorded === undefined && name !== undefined) {
    const claimed = events.slice(0, sent).some((event, index) => {
      if (event.type !== "PackageCalled" || event.name !== "agents.run" ||
        (event.arguments as { readonly name?: unknown } | undefined)?.name !== name) return false
      return !events.slice(index + 1).some((result) =>
        result.type === "PackageReturned" && result.callId === event.callId && turnOf(result) === turnOf(event) &&
        typeof (result.result as { readonly error?: unknown } | undefined)?.error === "string")
    })
    if (claimed) return { error: `agents.run thread name ${JSON.stringify(name)} is already claimed; choose another name` }
  }
  const lineage: ThreadLineage = recorded === undefined
    ? { ...childLineageOf(parent), ...(maxDepth === undefined ? {} : { maxDepth }) }
    : {
        parent: parent.address,
        depth: recorded.depth,
        ...(recorded.maxDepth === undefined ? {} : { maxDepth: recorded.maxDepth }),
        ...(recorded.placement === undefined ? {} : { placement: recorded.placement })
      }
  const target = recorded?.address ?? (yield* allocateChildThread({
    parent: source, child: childKeyOf(name ?? "unnamed"),
    ...(name === undefined ? { key: JSON.stringify([parentRunId, callId]) } : {})
  }))
  // clash rejects a derived address already claimed by another recorded child (agents.test.ts, "a derived address that names another child dies rather than delivering").
  if (recorded === undefined) {
    const clash = events.find(
      (event): event is ChildCreated =>
        Schema.is(ChildCreated)(event) &&
        event.address.actor === target.actor &&
        event.address.instance === target.instance &&
        event.address.thread === target.thread &&
        (event.callId !== callId || event.turn !== parentRunId)
    )
    if (clash !== undefined) {
      throw new Error(
        `agents.run ${callId} derives child address ${formatThreadAddress(target)}, which child ${clash.callId} already owns`
      )
    }
  }
  return { recorded, target, lineage }
})

const inheritedModelsOf = (events: ReadonlyArray<Event>): ModelPolicy => {
  const head = turnView(events)[0] as { readonly models?: unknown } | undefined
  return head?.models === undefined ? DEFAULT_MODEL_POLICY : modelPolicyOf(head.models)
}

// agentsPackage exposes model discovery, child dispatch, and result retrieval.
export const agentsPackage = (options: SpawnOptions = {}): Package<Router | Self | EventLog | ThreadAllocator> => {
  const { maxDepth } = options
  if (maxDepth !== undefined && (!Number.isSafeInteger(maxDepth) || maxDepth < 0)) {
    throw new Error("agentsPackage maxDepth must be a non-negative safe integer")
  }
  const initializeChild = options.initializeChild
  if (initializeChild !== undefined && !ACTOR_METHOD_NAME_PATTERN.test(initializeChild.methodName)) {
    throw new Error(`agentsPackage initializeChild methodName must match ${String(ACTOR_METHOD_NAME_PATTERN)}`)
  }
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
    description: "Search known providers and available models, and run ad-hoc agents. providers() lists provider configuration requirements and availability. models() lists models from available providers with metadata and pricing; use provider to limit the search and sort to order a pricing field. run({text}) starts a fresh agent with the brief and waits for its terminal answer; add background: true for a long job, and result({handle}) awaits the reply later. An escalatable child negotiates budget with its parent's requestBudget method while run remains pending.",
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
        description: `Brief a fresh agent. \`output\` makes the result structured and parsed: the name of a declared contract${declared_.length === 0 ? " (this host declares none)" : ` (${declared_.join(", ")})`}, or a JSON schema of your own. \`model\` selects one configured provider and model for this child. \`budget\` caps the agent's tool calls: at the cap it answers with its best result, so a research agent can not run forever. \`background: true\` returns { handle, callId } at once; result({handle}) awaits that exact invocation later. \`escalatable: true\` lets the child call its parent's requestBudget method at the cap while this run remains pending for one terminal answer.`,
        input: {
          type: "object",
          properties: {
            text: { type: "string", description: "the brief" },
            name: { type: "string", minLength: 1, description: "optional child thread name, unique within this actor instance; omitted names are generated by the host" },
            background: { type: "boolean", description: "true: return { handle, callId } at once; await the invocation with result({handle})" },
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
            escalatable: { type: "boolean", description: "true: at its budget the child may ask its parent's budget authority for more before answering" }
          },
          required: ["text"]
        },
        output: {
          type: "object",
          properties: {
            ...foregroundBoundarySchema.properties,
            maxDepth: { type: "integer", description: "effective inclusive depth ceiling when a spawn is refused" },
            attemptedDepth: { type: "integer", description: "refused child depth, with the root at zero" },
            dispatched: { type: "boolean" },
            callId: { type: "string" },
            handle: invocationCoordinateJsonSchema
          }
        }
      },
      result: {
        description: "Await a run fired with `background: true`. Answers its terminal once the reply lands; parks the execution until then. An answer comes back parsed when the child accepted a contract with that call.",
        input: {
          type: "object",
          properties: {
            handle: { ...invocationCoordinateJsonSchema, description: "the invocation handle returned by agents.run" }
          },
          required: ["handle"],
          additionalProperties: false
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
          const source = yield* Self
          const log = yield* EventLog
          const events = yield* log.read
          const created = threadCreatedOf(events)
          if (created === undefined) {
            return yield* Effect.die(new Error(`thread ${formatThreadAddress(source)} cannot spawn without ThreadCreated`))
          }
          const self = formatThreadAddress(source)
          const a = args as
            | { text?: unknown; name?: unknown; background?: unknown; output?: unknown; outputSchema?: unknown; model?: unknown; budget?: unknown; escalatable?: unknown }
            | undefined
          const text = String(a?.text ?? "")
          if (text === "") return { error: "agents.run needs { text }" }
          const name = a?.name
          if (name !== undefined && (typeof name !== "string" || name.length === 0)) {
            return { error: "agents.run name must be a non-empty string" }
          }
          const call = turnView(events).find((event) =>
            event.type === "PackageCalled" && event.callId === ctx.callId
          )
          const parentRun = call === undefined ? undefined : parentRunOf(call)
          if (parentRun === undefined) {
            return yield* Effect.die(new Error(`agents.run ${ctx.callId} has no parent turn`))
          }
          const ceiling = created.maxDepth === undefined ? maxDepth ?? DEFAULT_MAX_DEPTH
            : maxDepth === undefined ? created.maxDepth : Math.min(created.maxDepth, maxDepth)
          const child = yield* childClaimOf(events, created, parentRun.turn, ctx.callId, source, ceiling, name)
          if ("error" in child) return child
          const { lineage, recorded: recordedChild, target } = child
          const reference: InvocationCoordinate = recordedChild === undefined
            ? invocationCoordinateOf(target, { method: "message", id: ctx.callId, epoch: 0 })
            : childInvocationRef(recordedChild)
          const responseId = invocationResponseId(reference)
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
          const asked = a?.budget
          let want = defaultBudget
          if (asked !== undefined) {
            if (typeof asked !== "number" || !Number.isInteger(asked) || asked < 1) {
              return { error: `agents.run takes budget as a whole number of tool calls, at least 1; got ${JSON.stringify(asked)}` }
            }
            want = asked
          }
          const budget = yield* Effect.promise(() => reserve(ctx.callId, want))
          if (budget <= 0) return { error: "the run's budget is exhausted; no budget to spawn this agent" }
          const actor = actorNameOf()
          const shadow = shadowOf()
          const world = worldOf()
          // owner retains cancellation ownership in both dispatch modes (agents.test.ts, "a background child retains its invocation owner without waiting for its response").
          const owner = { method: "message", id: parentRun.turn, epoch: parentRun.epoch }
          const operation = yield* Effect.serviceOption(OperationScope)
          const parent = a?.background === true ? undefined : owner
          const parentDeadline = events.find((event) => {
            const context = (event as { readonly call?: unknown }).call as Partial<ActorInvocationContext> | undefined
            return context?.invocation !== undefined &&
              context.invocation.method === owner.method &&
              context.invocation.id === owner.id &&
              context.invocation.epoch === owner.epoch
          }) as ({ readonly call?: ActorInvocationContext } & Event) | undefined
          if (initializeChild !== undefined) {
            const parentInput = events.map((event) => messageInputOf(event, parentRun.turn))
              .find((input) => input !== undefined)
            const initializationContext: ChildInitializationContext = {
              parent: source,
              child: reference,
              parentInvocation: owner,
              callId: ctx.callId,
              text,
              ...(parentInput === undefined ? {} : { parentInput })
            }
            const initialization = invocationCoordinateOf(target, {
              method: initializeChild.methodName,
              id: initializeChild.invocationId?.(initializationContext) ?? `initialize:${ctx.callId}`,
              epoch: 0
            })
            const terminal = invocationTerminalOf(events, initialization)
            if (terminal === undefined) {
              const at = yield* Clock.currentTimeMillis
              const input = yield* Effect.promise(() => Promise.resolve(initializeChild.input(initializationContext)))
              const context: ActorInvocationContext = {
                invocation: initialization.invocation,
                parent: owner,
                ...(parentDeadline?.call?.deadlineAt === undefined ? {} : { deadlineAt: parentDeadline.call.deadlineAt })
              }
              const prepared = prepareInvocation({
                reference: initialization,
                method: initializeChild.method,
                context,
                input,
                at
              })
              const records: Event[] = recordedChild === undefined
                ? [childCreated(ctx.callId, target, lineage, at, parentRun.turn, reference.invocation)]
                : []
              records.push(invocationLinked({
                parent: owner,
                owner: operation._tag === "Some" ? operation.value : { type: "invocation", ref: owner },
                child: context,
                target: formatThreadAddress(target),
                lineage,
                at
              }))
              yield* log.append(records)
              yield* sendInvocation({
                target,
                context,
                lineage,
                event: { ...prepared.event, from: self, at }
              })
              return yield* new Park({ callId: ctx.callId, awaiting: invocationResponseId(initialization) })
            }
            const state = invocationResultOf(terminal, initializeChild.method.output)
            if (state.status === "failed") return { error: state.error.replace(/^error: /, "") }
            if (state.status === "cancelled") {
              return { error: state.reason === undefined ? "child initialization cancelled" : `child initialization cancelled: ${state.reason}` }
            }
            if (state.status !== "completed") {
              return yield* Effect.die(new Error(`child initializer ${initializeChild.methodName} returned a pending terminal`))
            }
          }
          const childContext: ActorInvocationContext = {
            invocation: reference.invocation,
            ...(parent === undefined ? {} : { parent }),
            ...(parentDeadline?.call?.deadlineAt === undefined ? {} : { deadlineAt: parentDeadline.call.deadlineAt })
          }
          const dispatch = (at: number) => Effect.gen(function* () {
            const prepared = prepareInvocation({
              reference, method: agentMessageMethod, context: childContext, at,
              input: { text, ...(selectedModel === undefined ? {} : { model: selectedModel }) }
            })
            const records: Event[] = recordedChild === undefined
              ? [childCreated(ctx.callId, target, lineage, at, parentRun.turn, reference.invocation)]
              : []
            records.push(invocationLinked({
              parent: owner,
              owner: operation._tag === "Some" ? operation.value : { type: "invocation", ref: owner }, child: childContext, target: formatThreadAddress(target), lineage, at
            }))
            if (records.length > 0) yield* log.append(records)
            yield* sendInvocation({ target, context: childContext, lineage, event: {
              ...prepared.event,
              ...(outputDeclaration === undefined ? {} : { output: outputDeclaration }),
              models,
              budget,
              ...(a?.escalatable === true ? { escalatable: true } : {}),
              ...(actor === undefined ? {} : { actor }),
              ...(shadow ? { shadow: true } : {}),
              ...(world === undefined ? {} : { world }),
              from: self,
              at
            } })
          })
          if (a?.background === true) {
            const at = yield* Clock.currentTimeMillis
            yield* dispatch(at)
            return { dispatched: true, callId: ctx.callId, handle: reference }
          }
          const already = childResultOf(yield* log.read, reference)
          if (already !== undefined) return shape(already, output)
          const at = yield* Clock.currentTimeMillis
          yield* dispatch(at)
          return yield* new Park({ callId: ctx.callId, awaiting: responseId })
        }),
      // result validates a background response against its recorded output contract (agents.test.ts, "a later call cannot invent a contract the run never declared").
      result: (args, ctx) =>
        Effect.gen(function* () {
          const a = args as { handle?: unknown } | undefined
          if (!Schema.is(InvocationCoordinate)(a?.handle)) return { error: "agents.result needs a valid invocation handle" }
          const handle = a.handle
          const log = yield* EventLog
          const events = yield* log.read
          const record = events.find((event): event is ChildCreated => Schema.is(ChildCreated)(event) &&
            invocationCoordinateKey(childInvocationRef(event)) === invocationCoordinateKey(handle))
          if (record === undefined) return { error: "no recorded child dispatch for this invocation handle" }
          const reference = childInvocationRef(record)
          const id = reference.invocation.id
          const reply = childResultOf(events, reference)
          if (reply !== undefined) {
            const output = contractOf(reply.data, id)
            if (output.contractError !== undefined) return { error: output.contractError }
            return shape(reply, output.contract)
          }
          return yield* new Park({ callId: ctx.callId, awaiting: invocationResponseId(reference) })
        })
    }
  })
}

// outputAsked resolves a named contract or validates an inline schema (agents.test.ts, "the output a spawn asks for").
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

// INLINE_OUTPUT_NAME labels inline output schemas on the wire.
export const INLINE_OUTPUT_NAME = "inline"

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

// childResultOf reads the terminal state of an exact child invocation (agents.test.ts).
const childResultOf = (events: ReadonlyArray<Event>, reference: InvocationCoordinate) => {
  const terminal = invocationTerminalOf(events, reference)
  if (terminal === undefined) return undefined
  const state = invocationResultOf(terminal, Schema.String)
  return state.status === "pending" ? undefined : state
}

// shape decodes successful output against its contract and reports validation failures (agents.test.ts, "a reply invalid under A but valid under B still fails as A").
const shape = (
  state: Exclude<ActorMethodState<string>, { readonly status: "pending" }>,
  contract: OutputContract | undefined
): unknown => {
  if (state.status === "failed") return { error: state.error.replace(/^error: /, "") }
  if (state.status === "cancelled") return { error: state.reason === undefined ? "cancelled" : `cancelled: ${state.reason}` }
  if (contract === undefined) return { output: state.output }
  const decoded = decodeOutput(contract, state.output)
  if (decoded.errors.length > 0) {
    return {
      error: `the run answered outside its declared contract "${contract.name}": ${decoded.errors.join("; ")}`
    }
  }
  return { output: decoded.value }
}
