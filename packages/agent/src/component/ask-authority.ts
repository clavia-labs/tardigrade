import { bindTransitionContext } from "@clavia/tardigrade-core/transition/transition"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { HashMap, HashSet, Schema } from "effect"
import type { KeyFragment } from "@clavia/tardigrade-core/log"
import { type Transition } from "@clavia/tardigrade-core/runtime"
import { externallyHandled, handles, component as defineComponent, type Component } from "@clavia/tardigrade-core/actor"
import { formatThreadAddress, isThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { AskDecision, requestAskMethod } from "../actor/ask"
import { askRequestDecided, askRequestFailed } from "../log/events"
import { outputErrors, outputProfileErrors } from "../output/contract"

// AskRequest describes one durable authority call and supplies its valid decisions.
export interface AskRequest {
  readonly id: string
  readonly request: string
  readonly turn: string
  readonly prompt: string
  readonly schema: unknown
  readonly from?: string
  readonly answer: (value: unknown) => AskDecision
  readonly deny: (reason?: string) => AskDecision
}

// DecideAsk is the pure local policy implemented by askAuthority.
export type DecideAsk = (request: AskRequest) => AskDecision

export interface AskAuthorityOptions {
  readonly decide: DecideAsk
}

// askAuthorityKeys owns ask authority calls and their terminal outcomes.
export const askAuthorityKeys: KeyFragment = {
  prefixes: ["aar:", "aa:"],
  keyOf: (event) => {
    const value = event as Record<string, unknown>
    if (event.type === "AskRequestReceived") return `aar:${String(value.id)}`
    return event.type === "AskRequestDecided" || event.type === "AskRequestFailed"
      ? `aa:${String(value.callId)}`
      : undefined
  }
}

const failureMessage = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure)

type ReceivedAskRequest = Event & {
  readonly id?: unknown
  readonly request?: unknown
  readonly turn?: unknown
  readonly prompt?: unknown
  readonly schema?: unknown
  readonly link?: { readonly source?: unknown }
}

interface AskAuthorityState {
  readonly next: number
  readonly pending: HashMap.HashMap<string, { readonly order: number; readonly event: ReceivedAskRequest }>
  readonly settled: HashSet.HashSet<string>
}

const reduceAuthority = (state: AskAuthorityState, event: Event): AskAuthorityState => {
  if (event.type === "AskRequestDecided" || event.type === "AskRequestFailed") {
    const id = String((event as { readonly callId?: unknown }).callId ?? "")
    return {
      ...state,
      pending: HashMap.remove(state.pending, id),
      settled: HashSet.add(state.settled, id)
    }
  }
  if (event.type !== "AskRequestReceived") return state
  const received = event as ReceivedAskRequest
  const id = String(received.id ?? "")
  return HashSet.has(state.settled, id) || HashMap.has(state.pending, id)
    ? state
    : {
        ...state,
        next: state.next + 1,
        pending: HashMap.set(state.pending, id, { order: state.next, event: received })
      }
}

const answerErrors = (schema: unknown, value: unknown): ReadonlyArray<string> => {
  const profile = outputProfileErrors(schema)
  return profile.length > 0 ? profile : outputErrors(schema, value)
}

const authorityTransition = (
  received: ReceivedAskRequest | undefined,
  decide: DecideAsk
): Transition<never> | undefined => {
  if (received === undefined) return undefined

  const id = String(received.id ?? "")
  const context = bindTransitionContext(received, "ask-authority")
  const request: AskRequest = {
    id,
    request: String(received.request ?? ""),
    turn: String(received.turn ?? ""),
    prompt: String(received.prompt ?? ""),
    schema: received.schema,
    ...(isThreadAddress(received.link?.source) ? { from: formatThreadAddress(received.link.source) } : {}),
    answer: (value) => ({ answered: value }),
    deny: (reason) => ({ denied: true, ...(reason === undefined ? {} : { reason }) })
  }

  try {
    const decision = Schema.decodeSync(AskDecision)(decide(request))
    if ("answered" in decision) {
      const errors = answerErrors(received.schema, decision.answered)
      if (errors.length > 0) {
        throw new Error(`ask answer misses the schema:\n${errors.map((error) => `- ${error}`).join("\n")}`)
      }
      return context.intent("decide", (at) => askRequestDecided({ callId: id, denied: false, answer: decision.answered, at }))
    }
    return context.intent("decide", (at) => askRequestDecided({
      callId: id, denied: true, ...("denied" in decision && decision.reason !== undefined ? { reason: decision.reason } : {}), at
    }))
  } catch (failure) {
    return context.intent("decide", (at) => askRequestFailed({ callId: id, error: failureMessage(failure), at }))
  }
}

const authorityComponent = (decide?: DecideAsk): Component<undefined> => {
  const component: Component<undefined> = defineComponent({
    name: "ask-authority",
    initial: (): AskAuthorityState => ({ next: 0, pending: HashMap.empty(), settled: HashSet.empty() }),
    step: reduceAuthority,
    output: (state) => {
      if (decide === undefined) return { view: undefined, transitions: [] }
      const received = Array.from(HashMap.values(state.pending))
        .reduce((first, candidate) => first === undefined || candidate.order < first.order ? candidate : first, undefined as { readonly order: number; readonly event: ReceivedAskRequest } | undefined)
        ?.event
      const transition = authorityTransition(received, decide)
      return { view: undefined, transitions: transition === undefined ? [] : [transition] }
    }
  })
  return decide === undefined
    ? externallyHandled(requestAskMethod, { ...component, keys: askAuthorityKeys })
    : handles(requestAskMethod, { ...component, keys: askAuthorityKeys })
}

// askAuthority handles requestAsk with a pure local decision policy.
export const askAuthority = Object.assign(
  (options: AskAuthorityOptions): Component<undefined> => authorityComponent(options.decide),
  {
    // askAuthority.manual leaves requestAsk pending for an external decision.
    manual: (): Component<undefined> => authorityComponent()
  }
)
