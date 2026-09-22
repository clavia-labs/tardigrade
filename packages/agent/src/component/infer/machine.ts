import { estimateTokens } from "../../projection/tokens"
import { withResponse, type ComponentWork } from "@clavia/tardigrade-core/actor"
import { ModelLock } from "@clavia/tardigrade-model/lock"
import type { Context } from "effect"
import { upcastError } from "../../log/upcast"
import { hasUnansweredToolCall, responsesOf } from "../../log/response"
import { bindTransitionContext } from "@clavia/tardigrade-core/transition/transition"
import { eventAt, eventPositionOf } from "@clavia/tardigrade-core/event"
import { RetrySchedule, retryDelayOf, canFallback } from "./retry"
import { LanguageModel } from "effect/unstable/ai"
import { react } from "../../model/execution/index"
import { unknownModelError } from "../../model/error"
import { BindingSettings, modelSettingsFor } from "@clavia/tardigrade-model/settings"
import { Cause, Clock, Effect, Random, Schema } from "effect"
import { EventLog } from "@clavia/tardigrade-core/log"
import { HashMap, Option } from "effect"
import { Self } from "@clavia/tardigrade-core/runtime"
import { type CompleteTransitionDerivation } from "@clavia/tardigrade-core/transition"
import { modelCalled, modelReturned, outputRejected, outputRepaired, textReturned, turnFailed } from "../../log/events"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { Action } from "../../log/events"
import { trajectoryOf, turnEpochOf, turnView } from "@clavia/tardigrade-code/execution/turns"
import {
  initialTurnProjection,
  reduceTurnProjection,
  trajectoryFrom,
  turnEpochFrom,
  turnViewFrom,
  type TurnProjectionState
} from "@clavia/tardigrade-code/execution/turn-projection"
import {
  asksAgain,
  correctionsOf,
  decodeOutput,
  declaredOutputOf,
  fingerprintOf,
  modeOf,
  mismatchCauseOf,
  projectsHistory,
  recordsRejection,
  type OutputContract
} from "../../output/contract"
import { modelRefOf, type ModelRef } from "../../model/reference"
import {
  applyModelPolicy,
  DEFAULT_MODEL_POLICY,
  modelAllowedBy,
  modelPolicyOf,
  type ModelPolicy
} from "../../model/access"
import {
  DEFAULT_INFER_POLICY,
  type InferPolicy,
  type Render
} from "./contract"
import type { ModelResolution } from "../../model/contract"

// The inference machine derives a model attempt when the current turn has no unanswered tool call or terminal.
// selectedModelOf applies the visible model-selection order for one turn (component/infer/infer.test.ts, "the actor owns model selection").
export const selectedModelOf = (head: Event, policy?: ModelRef): ModelRef | undefined => {
  const selected = (head as { readonly model?: unknown }).model
  return selected === undefined ? policy : modelRefOf(selected)
}

class ModelSelectionError extends Error {}

const resolvedModelFor = (
  resolve: Context.Service.Shape<typeof ModelLock>["resolve"],
  reference: ModelRef | undefined,
  models: ModelPolicy,
  policyError: string | undefined
): ModelResolution => {
  if (policyError !== undefined) throw new ModelSelectionError(policyError)
  if (reference !== undefined && !modelAllowedBy(models, reference)) {
    throw new ModelSelectionError(`model ${reference.provider}/${reference.model_id} is excluded by the effective model policy`)
  }
  const resolved = resolve(reference)
  const allowed = applyModelPolicy(resolved.models ?? DEFAULT_MODEL_POLICY, models)
  if (!modelAllowedBy(allowed, resolved.model)) {
    throw new ModelSelectionError(`model ${resolved.model.provider}/${resolved.model.model_id} is excluded by the effective model policy`)
  }
  return { ...resolved, models: allowed }
}

const epochStamp = (epoch: number): { readonly epoch?: number } =>
  epoch === 0 ? {} : { epoch }

// Consequence is what one action is recorded against: the turn and attempt it answers, the
// contract its final response owes, and the implementation that judges a response missing it.
interface Consequence {
  readonly turn: string
  readonly epoch: number
  readonly attempt: string
  readonly at: number
  readonly contract: OutputContract | undefined
}

const stampOf = (action: Action): { readonly endpoint?: unknown } =>
  action.endpoint === undefined ? {} : { endpoint: action.endpoint }

// completionOf judges one `complete` action against the turn's declared contract. An undeclared
// turn ends in prose. A declared one is validated here whatever the provider promised, so a
// strict binding is checked rather than trusted (../turn.test.ts, "a turn that declares an output
// contract"). What a mismatch means belongs to the implementation: a terminal under native or
// local, and a recorded rejection under the two that carry on (src/output/contract.ts, mismatchCauseOf).
const completionOf = (action: Action & { readonly kind: "complete" }, ctx: Consequence): Event => {
  const mode = action.mode
  const completed = {
    type: "TurnCompleted",
    output: action.output,
    attemptKey: ctx.attempt,
    ...(mode === undefined ? {} : { mode }),
    ...stampOf(action),
    turn: ctx.turn,
    ...epochStamp(ctx.epoch),
    at: ctx.at
  } as Event
  if (ctx.contract === undefined) return completed
  // mode identifies the binding's output contract enforcement (binding/output.ts, outputModeOf).
  if (mode === undefined) {
    return {
      type: "TurnFailed",
      error: { message: `the model binding answered a turn declaring "${ctx.contract.name}" without stating the output mode it ran in` },
      turn: ctx.turn,
      ...epochStamp(ctx.epoch),
      cause: "inference_error",
      attempts: 1,
      attemptKey: ctx.attempt,
      ...stampOf(action),
      at: ctx.at
    } as Event
  }
  const decoded = decodeOutput(ctx.contract, action.output)
  if (decoded.errors.length === 0) return completed
  if (recordsRejection(mode)) {
    return outputRejected({
      contract: ctx.contract.name,
      fingerprint: fingerprintOf(ctx.contract),
      attempt: ctx.attempt,
      text: action.output,
      errors: decoded.errors,
      mode,
      ...stampOf(action),
      turn: ctx.turn,
      ...epochStamp(ctx.epoch),
      at: ctx.at
    })
  }
  const cause = mismatchCauseOf(mode) ?? "output_contract_violation"
  return {
    type: "TurnFailed",
    error: { message:
      `the response missed the declared output contract "${ctx.contract.name}" in ${mode.name} mode:\n` +
      decoded.errors.map((e) => `- ${e}`).join("\n") },
    turn: ctx.turn,
    ...epochStamp(ctx.epoch),
    cause,
    attempts: 1,
    attemptKey: ctx.attempt,
    policy: mode,
    ...stampOf(action),
    at: ctx.at
  } as Event
}

// consequencesOf records each tool request separately under its model response (runtime/batches.test.ts).
const consequencesOf = (action: Action, ctx: Consequence): ReadonlyArray<Event> => {
  if (action.kind === "complete") return [completionOf(action, ctx)]
  const stamp = {
    turn: ctx.turn,
    ...epochStamp(ctx.epoch),
    ...(action.mode === undefined ? {} : { mode: action.mode }),
    ...stampOf(action),
    at: ctx.at
  }
  if (action.kind === "fail") return [{
    ...stamp,
    type: "TurnFailed",
    error: upcastError(action.error),
    cause: action.failure?.cause ?? "model",
    attemptKey: ctx.attempt,
    ...(action.failure === undefined ? {} : { attempts: action.failure.attempts, policy: action.failure.policy })
  }]
  if (ctx.contract !== undefined && action.mode === undefined) return [{
    ...stamp,
    type: "TurnFailed",
    error: { message: `the model binding answered a turn declaring "${ctx.contract.name}" with a tool call but did not state the output mode it ran in` },
    cause: "inference_error",
    attempts: 1,
    attemptKey: ctx.attempt
  }]
  return action.calls.map((call) => ({ type: "ToolCalled", ...call, ...stamp, responseId: ctx.attempt }))
}

// diedAttempts counts the `ModelCalled` marks at the end of the turn's slice, with nothing after
// them. Any committed event after a mark is progress and resets the count. Counting inside the
// slice keeps a queued message on the log from masking a crash loop.
const diedAttempts = (turn: ReadonlyArray<Event>, epoch: number): number => {
  let n = 0
  for (let i = turn.length - 1; i >= 0; i--) {
    const event = turn[i]!
    if (event.type === "ModelCalled" && Number((event as { epoch?: unknown }).epoch ?? 0) === epoch) n += 1
    else break
  }
  return n
}

const terminated = (slice: ReadonlyArray<Event>): boolean =>
  slice.some((e) => e.type === "TurnCompleted" || e.type === "TurnFailed" || e.type === "TurnCancelled")

const rejectionsIn = (events: ReadonlyArray<Event>): ReadonlyArray<Event> =>
  events.filter((event) => event.type === "OutputRejected")

// openRejection returns the rejection this turn still owes an answer to: the last one no
// `OutputRetryRequested` has released. It is what parks a delegated turn, so the component that
// mounted the implementation decides what happens next instead of the reactor asking again by
// itself (src/output/contract.ts, asksAgain).
const openRejection = (events: ReadonlyArray<Event>): Event | undefined => {
  const answered = new Set(
    events
      .filter((e) => e.type === "OutputRetryRequested")
      .map((e) => String((e as { rejection?: unknown }).rejection))
  )
  return rejectionsIn(events)
    .filter((event) => !answered.has(String((event as { attempt?: unknown }).attempt)))
    .at(-1)
}

// Render derives what the model is shown over this log: the assembly owns it (component/infer/index.ts,
// renderOf).
interface InferDerivation<R> {
  readonly lock: Context.Service.Shape<typeof ModelLock>
  readonly slice: ReadonlyArray<Event>
  readonly epoch: number
  readonly trajectory: () => ReadonlyArray<Event>
  readonly modelFailures: number
  readonly rendered: ReturnType<Render<R>>
}

export interface InferRejection {
  readonly error: string
}

const inferTransitionsFor = <R>(policy: Partial<InferPolicy>, derived: InferDerivation<R>): ReadonlyArray<ComponentWork<R | LanguageModel.LanguageModel | EventLog | Self, InferRejection>> => {
  const giveUpAfter = policy.giveUpAfter ?? DEFAULT_INFER_POLICY.giveUpAfter
  const slice = derived.slice
  if (slice.length === 0 || hasUnansweredToolCall(slice) || terminated(slice)) return []
  const context = bindTransitionContext(slice[slice.length - 1]!, "infer")
  const head = slice[0] as Event & { id?: unknown }
  const turn = String(head.id)
  const epoch = derived.epoch
  const inheritedModels = modelPolicyOf((head as { readonly models?: unknown }).models)
  let policyError: string | undefined
  let models = inheritedModels
  try {
    models = applyModelPolicy(inheritedModels, policy.models ?? DEFAULT_INFER_POLICY.models)
  } catch (error) {
    policyError = error instanceof Error ? error.message : String(error)
  }
  const died = diedAttempts(slice, epoch)
  const epochAttempts = slice.flatMap((event) => Number(event.epoch ?? 0) === epoch ? [{
    event,
    model: event.type === "ModelCalled" ? modelRefOf(event.model) : undefined,
    retry: event.type === "ModelReturned" && Schema.is(RetrySchedule)(event.retry) ? event.retry : undefined
  }] : [])
  const pendingRetry = epochAttempts.findLast(({ event }) => event.type === "ModelReturned")?.retry
  const lastMark = epochAttempts.findLast(({ event }) => event.type === "ModelCalled")
  const switchModel = epochAttempts.findLast(({ retry }) => retry?.model !== undefined)?.retry?.model
  const model = (died > 0 ? lastMark?.model : pendingRetry?.model) ??
    (pendingRetry !== undefined ? lastMark?.model : undefined) ?? switchModel ?? selectedModelOf(head, models.default)
  const attempted = epochAttempts.flatMap(({ model, retry }) => {
    const reference = model ?? retry?.model
    return reference === undefined ? [] : [reference]
  })
  const marks = slice.filter((e) => e.type === "ModelCalled").length
  const modelFailures = derived.modelFailures
  // A rejected response is a spent logical attempt: the next ask must not reuse the idempotency
  // key, or a deduping provider answers the correction with the response it just refused.
  const logicalAttempt = Math.max(
    slice.filter((event) => event.type === "ModelReturned").length,
    responsesOf(slice).returnedAttempts + modelFailures + slice.filter((event) => event.type === "ModelReturned" && event.retry !== undefined).length
  )
  const attempt = `${turn}/infer/${logicalAttempt}`
  const rendered = derived.rendered
  const fallback = rendered.output?.fallback
  const declared = declaredOutputOf(slice)
  const terminate = (
    input: {
      readonly cause: import("../../log/events").TurnFailureCause
      readonly error: string
      readonly attempts: number
      readonly policy: unknown
    }
  ) => [
    context.intent("fail", (at) => turnFailed({
      ...input, attemptKey: attempt, turn, ...epochStamp(epoch), at
    }), { invocation: { method: "message", id: turn, epoch } })
  ]
  // A declaration that is not a contract this repository can serve ends the turn here, before a
  // socket opens. It is the same class the binding reports when an endpoint cannot promise a
  // contract, because both are the turn asking for an output nobody can produce.
  if (declared.kind === "invalid") {
    return terminate({
      cause: "output_unsupported",
      error: `the turn's declared output cannot be served:\n${declared.errors.map((e) => `- ${e}`).join("\n")}`,
      attempts: 0,
      policy: fallback ?? null
    })
  }
  const contract = declared.kind === "contract" ? declared.contract : undefined
  // The give-up and correction bounds are derivations, so each derives its own terminal
  // transition: one terminal per turn epoch, and a duplicate of either kind absorbs.
  if (died >= giveUpAfter) {
    return terminate({
      cause: "inference_attempts_exhausted",
      error: `the model attempt died ${giveUpAfter} times in a row`,
      attempts: died,
      policy: { giveUpAfter }
    })
  }
  const epochStart = slice.findLastIndex(
    (event) => event.type === "TurnResumed" && Number((event as { epoch?: unknown }).epoch) === epoch
  )
  const epochEvents = epochStart === -1 ? slice : slice.slice(epochStart + 1)
  const rejections = rejectionsIn(epochEvents)
  const owed = openRejection(epochEvents)
  if (owed !== undefined) {
    const spent = modeOf((owed as { mode?: unknown }).mode)
    // A rejection with no recorded mode is a log this reactor did not write. Asking again on a
    // policy nobody recorded would be a guess, so the turn ends instead.
    if (spent === undefined) {
      return terminate({
        cause: "output_validation_failed",
        error: "a rejected response carries no recorded output mode, so no correction policy applies to it",
        attempts: rejections.length,
        policy: null
      })
    }
    // A delegated mode parks here. The component that mounted it reads the rejection and decides:
    // its own feedback through `OutputRetryRequested`, its own terminal, or nothing. The reactor
    // never schedules the framework loop on its behalf.
    if (!asksAgain(spent)) return []
    const allowed = correctionsOf(spent)
    if (rejections.length > allowed) {
      return terminate({
        cause: "output_repairs_exhausted",
        error: `the response did not satisfy the declared output contract after ${allowed} correction${allowed === 1 ? "" : "s"}`,
        attempts: rejections.length,
        policy: spent
      })
    }
  }
  if (rendered.conversation?.ready === false) return []
  let resolution: ModelResolution
  try {
    resolution = resolvedModelFor(derived.lock.resolve, model, models, policyError)
  } catch (error) {
    return terminate({ cause: error instanceof ModelSelectionError || model === undefined ? "model_selection" : "inference_error", error: error instanceof Error ? error.message : String(error), attempts: 0, policy: model ?? null })
  }
  const selected = resolution.model
  let contextPolicy = rendered.context ?? {}
  const conversation = rendered.conversation
  if (conversation?.compaction !== undefined) {
    try {
      const window = resolution.contextWindowTokens
      if (window === undefined || !Number.isSafeInteger(window) || window <= 0) throw new Error("The active model requires a positive context window for compaction")
      const { triggerRatio, proposals } = conversation.compaction
      contextPolicy = { ...contextPolicy, contextWindowTokens: window, fireRatio: triggerRatio, fireTokens: Math.floor(window * triggerRatio) }
      if (proposals.length > 0 && estimateTokens(conversation.trajectory, contextPolicy, selected) > contextPolicy.fireTokens!) {
        return (rendered.compactionTransitions ?? []).filter(proposal => proposals.includes(proposal.key))
      }
    } catch (error) {
      return terminate({ cause: "model_selection", error: error instanceof Error ? error.message : String(error), attempts: 0, policy: model ?? null })
    }
  }
  // attempt advances after a recorded response and survives an unanswered crash (integration/infer-retry.test.ts).
  return [
    withResponse(context.effect("infer", {
      invocation: { method: "message", id: turn, epoch },
      input: {
        turn,
        epoch,
        attempt,
        ordinal: marks,
        retryIndex: pendingRetry?.index ?? (died > 0 ? Number(lastMark?.event.retryIndex ?? 0) : 0),
        dueAt: pendingRetry?.dueAt,
        trajectory: derived.trajectory,
        model,
        // The declared policy, stamped on the ask: the contract's identity and the fallback the
        // assembly mounted. The mode the attempt actually ran in is the binding's to report, and
        // it lands on the consequence (events.ts, OutputPolicy; completionOf above).
        stamp:
          contract === undefined
            ? undefined
            : {
                contract: contract.name,
                fingerprint: fingerprintOf(contract),
                ...(fallback === undefined ? {} : { fallback })
              },
        contract
      },
      act: (input, { signal }) =>
        Effect.gen(function* () {
          const events = yield* EventLog
          const self = yield* Self
          if (input.dueAt !== undefined) {
            const now = yield* Clock.currentTimeMillis
            if (input.dueAt > now) yield* Effect.sleep(input.dueAt - now)
          }
          const at = yield* Clock.currentTimeMillis
          const settings = yield* modelSettingsFor(selected)
          const requestPolicy = settings.policy
          const pricing = settings.pricing
          const { compactionTransitions: _compactions, ...modelRender } = rendered
          const actualRender = { ...modelRender, context: contextPolicy }
          const trajectory = input.trajectory()
          yield* events.append([modelCalled({
            callId: input.attempt, model: selected, ordinal: input.ordinal, retryIndex: input.retryIndex,
            ...(pricing === undefined ? {} : { pricing }),
            ...(input.stamp === undefined ? {} : { output: input.stamp }),
            turn: input.turn, ...epochStamp(input.epoch), at
          })])
          let partialOutput = ""
          let partialPersisted = false
          const persistPartialOutput = () => {
            if (partialOutput === "" || partialPersisted) return Effect.void
            partialPersisted = true
            return Clock.currentTimeMillis.pipe(
              Effect.flatMap((at) => events.append([textReturned({
                text: partialOutput, turn: input.turn, ...epochStamp(input.epoch), at
              })])),
              Effect.asVoid
            )
          }
          const action = yield* react(
              {
                trajectory,
                identity: { ...self, turn: input.turn },
                model: selected,
                ...actualRender
              },
              input.attempt,
              signal,
              (delta) => {
                if (delta.kind !== "reasoning") partialOutput += delta.text
              }
            )
            .pipe(
              Effect.provideService(BindingSettings, settings),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.succeed<Action>({
                      kind: "fail",
                      error: unknownModelError(Cause.squash(cause)),
                      failure: { cause: "inference_error", attempts: 1 }
                    })
              ),
              Effect.onInterrupt(persistPartialOutput),
              // Abort can settle the provider before interruption; both paths share the persistence guard (index.test.ts).
              Effect.ensuring(
                Effect.suspend(() => signal?.aborted === true ? persistPartialOutput() : Effect.void)
              )
            )
          const after = yield* Clock.currentTimeMillis
          const calls = action.kind === "calls" ? action.calls : []
          const seen = new Set(trajectory.filter((event) => event.type === "ToolCalled" && event.turn === input.turn).map((event) => String(event.callId)))
          const duplicate = calls.find((call) => {
            if (seen.has(call.callId)) return true
            seen.add(call.callId)
            return false
          })
          const invalid = action.kind === "calls" && calls.length === 0
          const checked: Action = duplicate !== undefined || invalid ? {
            kind: "fail", error: duplicate === undefined ? "the model returned an empty tool batch" : `duplicate tool call ID ${JSON.stringify(duplicate.callId)} within turn ${JSON.stringify(input.turn)}`,
            ...(action.usage === undefined ? {} : { usage: action.usage }),
            ...(action.endpoint === undefined ? {} : { endpoint: action.endpoint }),
            failure: { cause: "inference_error", attempts: 1 }
          } : action
          const delay = checked.kind === "fail" && checked.retryable === true && requestPolicy !== undefined
            ? retryDelayOf(requestPolicy, input.retryIndex, checked.retryAfterMs, yield* Random.next)
            : undefined
          const nextModel = delay === undefined && canFallback(checked)
            ? resolution.models?.fallback?.find((candidate) => ![...attempted, selected, ...(input.model === undefined ? [] : [input.model])].some((previous) => previous.provider === candidate.provider && previous.model_id === candidate.model_id))
            : undefined
          const retry = delay !== undefined ? { dueAt: after + delay, index: input.retryIndex + 1 }
            : nextModel === undefined ? undefined : { dueAt: after, index: 0, model: nextModel }
          const consequences = retry === undefined ? consequencesOf(checked, {
            turn: input.turn,
            epoch: input.epoch,
            attempt: input.attempt,
            at: after,
            contract: input.contract
          }) : []
          const repaired = consequences.some((event) => event.type === "TurnCompleted")
            ? trajectory.filter((event) => {
                if (event.type !== "OutputRejected") return false
                const value = event as { readonly turn?: unknown; readonly epoch?: unknown; readonly mode?: unknown }
                const mode = modeOf(value.mode)
                return String(value.turn ?? "") === input.turn &&
                  Number(value.epoch ?? 0) === input.epoch &&
                  mode !== undefined &&
                  projectsHistory(mode)
              })
            : []
          return [
            modelReturned({
              callId: input.attempt, ordinal: input.ordinal, turn: input.turn, ...epochStamp(input.epoch),
              outcome: action.kind === "fail" ? "failed" : "returned",
              ...(retry === undefined ? {} : { retry }),
              usage: action.usage ?? {}, ...stampOf(action),
              ...(action.reasoning === undefined ? {} : { reasoning: action.reasoning }),
              ...(action.continuation === undefined ? {} : { continuation: action.continuation }),
              ...(action.response === undefined ? {} : { response: action.response }),
              ...(action.finish === undefined ? {} : { finish: action.finish }),
              ...(action.reportedCostUsd === undefined ? {} : { reportedCostUsd: action.reportedCostUsd }),
              ...(action.kind === "fail" ? { error: action.error, ...(action.text === undefined ? {} : { text: action.text }) } : {}), at: after
            }),
            ...(action.kind === "calls" && action.text !== undefined && action.text !== ""
              ? [textReturned({ text: action.text, turn: input.turn, at: after })]
              : []),
            ...repaired.map((event) => outputRepaired({
              replaced: String((event as { readonly attempt?: unknown }).attempt ?? ""),
              replacement: input.attempt,
              turn: input.turn,
              ...epochStamp(input.epoch),
              at: after
            })),
            ...consequences
          ]
        })
    }), (result: InferRejection) => bindTransitionContext(head, "infer").intent(`refuse/${epoch}/${attempt}`, (at) => turnFailed({
      cause: "refused", error: result.error, attempts: marks, policy: null,
      attemptKey: attempt, turn, ...epochStamp(epoch), at
    }), { invocation: { method: "message", id: turn, epoch } }))
  ]
}

// inferenceFromHistory derives inference through complete replay.
export const inferenceFromHistory = <R = never>(policy: Partial<InferPolicy>, render: Render<R>, lock: Context.Service.Shape<typeof ModelLock>): CompleteTransitionDerivation<R | LanguageModel.LanguageModel | EventLog | Self> => (history) => {
  const log = history.map((event, index) => eventPositionOf(event) === undefined ? eventAt(event, index + 1) : event)
  const slice = turnView(log)
  const turn = String((slice[0] as { readonly id?: unknown } | undefined)?.id ?? "")
  return inferTransitionsFor(policy, {
    lock,
    slice,
    epoch: turnEpochOf(log, turn),
    trajectory: () => trajectoryOf(log),
    modelFailures: log.filter(
      (event) =>
        event.type === "TurnFailed" &&
        String((event as { readonly turn?: unknown }).turn) === turn &&
        String((event as { readonly cause?: unknown }).cause) === "model"
    ).length,
    rendered: render(log)
  })
}

interface IncrementalInferState {
  readonly lock: Context.Service.Shape<typeof ModelLock>
  readonly turns: TurnProjectionState
  readonly modelFailures: HashMap.HashMap<string, number>
}

// inferenceMachine tracks turn lifecycle while its caller supplies the rendered child output (runtime/refinement.properties.test.ts).
export const inferenceMachine = (policy: Partial<InferPolicy>) => ({
  initial: (lock: Context.Service.Shape<typeof ModelLock>): IncrementalInferState => ({
    lock,
    turns: initialTurnProjection(),
    modelFailures: HashMap.empty()
  }),
  step: (state: IncrementalInferState, event: Event): IncrementalInferState => {
    const turn = String((event as { readonly turn?: unknown }).turn ?? "")
    const failed = event.type === "TurnFailed" && String((event as { readonly cause?: unknown }).cause) === "model"
    const count = Option.getOrElse(HashMap.get(state.modelFailures, turn), () => 0)
    return {
      ...state,
      turns: reduceTurnProjection(state.turns, event),
      modelFailures: failed ? HashMap.set(state.modelFailures, turn, count + 1) : state.modelFailures
    }
  },
  output: <R>(state: IncrementalInferState, render: Pick<InferDerivation<R>, "rendered">) => {
    const slice = turnViewFrom(state.turns)
    const turn = String((slice[0] as { readonly id?: unknown } | undefined)?.id ?? "")
    return inferTransitionsFor(policy, {
      slice,
      epoch: turnEpochFrom(state.turns, turn),
      trajectory: () => trajectoryFrom(state.turns),
      modelFailures: Option.getOrElse(HashMap.get(state.modelFailures, turn), () => 0),
      ...render,
      lock: state.lock
    })
  }
})
