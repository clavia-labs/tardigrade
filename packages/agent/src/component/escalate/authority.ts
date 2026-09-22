import { Chunk, HashMap, HashSet } from "effect"
import {
  calls,
  component,
  externallyHandled,
  handles,
  type ActorMethods,
  type ActorMethodInput,
  type ActorMethodOutput,
  type Component
} from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/event"
import type { Intent } from "@clavia/tardigrade-core/intent"
import type { KeyFragment } from "@clavia/tardigrade-core/log"
import { bindTransitionContext } from "@clavia/tardigrade-core/transition/transition"
import { actorCall } from "@clavia/tardigrade-core/interaction/invoke"
import { actorInvocationContextFrom } from "@clavia/tardigrade-core/interaction/invocation"
import { Self, type Transition } from "@clavia/tardigrade-core/runtime"
import { Router } from "@clavia/tardigrade-core/transport/router"
import { formatThreadAddress, isThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { authorityTarget, type AuthorityTarget } from "./target"

export interface AuthorityRequest<Input> {
  readonly id: string
  readonly input: Input
  readonly from?: string
}

export type AuthorityComponent<Input, Decision, R = never> = Component<
  {
    readonly pending: ReadonlyArray<AuthorityRequest<Input>>
  },
  R,
  never,
  {
    readonly respond: (id: string, decision: Decision) => Intent<never> | undefined
  }
>

interface AuthorityDefinition<Methods extends ActorMethods, Name extends Extract<keyof Methods, string>, Request> {
  readonly name: string
  readonly methods: Methods
  readonly method: Name
  readonly received: string
  readonly decided: string
  readonly failed: string
  readonly keys: KeyFragment
  readonly input: (event: Event) => ActorMethodInput<Methods[Name]>
  readonly request: (pending: AuthorityRequest<ActorMethodInput<Methods[Name]>>) => Request
  readonly decision: (id: string, decision: ActorMethodOutput<Methods[Name]>, at: number) => Event
  readonly failure: (id: string, error: string, at: number) => Event
}

type Options<Methods extends ActorMethods, Name extends keyof Methods, Request> =
  | { readonly decide: (request: Request) => ActorMethodOutput<Methods[Name]>; readonly delegate?: never }
  | { readonly delegate: AuthorityTarget<Methods>; readonly decide?: never }

export function authorityComponent<M extends ActorMethods, N extends Extract<keyof M, string>, Request>(
  definition: AuthorityDefinition<M, N, Request>,
  options?: { readonly decide: (request: Request) => ActorMethodOutput<M[N]>; readonly delegate?: never }
): AuthorityComponent<ActorMethodInput<M[N]>, ActorMethodOutput<M[N]>>
export function authorityComponent<M extends ActorMethods, N extends Extract<keyof M, string>, Request>(
  definition: AuthorityDefinition<M, N, Request>,
  options: { readonly delegate: AuthorityTarget<M>; readonly decide?: never }
): AuthorityComponent<ActorMethodInput<M[N]>, ActorMethodOutput<M[N]>, Router | Self>
// authorityComponent keeps manual and delegated decisions pending until their completion is committed (authority.test.ts).
export function authorityComponent<M extends ActorMethods, N extends Extract<keyof M, string>, Request>(
  definition: AuthorityDefinition<M, N, Request>,
  options?: Options<M, N, Request>
): AuthorityComponent<ActorMethodInput<M[N]>, ActorMethodOutput<M[N]>, Router | Self> {
  type Input = ActorMethodInput<M[N]>
  type Decision = ActorMethodOutput<M[N]>
  type State = {
    readonly pending: HashMap.HashMap<string, { readonly order: number; readonly event: Event }>
    readonly settled: HashSet.HashSet<string>
    readonly log: Chunk.Chunk<Event>
    readonly next: number
  }
  const requestOf = (event: Event): AuthorityRequest<Input> => {
    const source = (event as { readonly link?: { readonly source?: unknown } }).link?.source
    return {
      id: String(event.id ?? ""),
      input: definition.input(event),
      ...(isThreadAddress(source) ? { from: formatThreadAddress(source) } : {})
    }
  }
  const complete = (event: Event, decision: Decision): Intent<never> => {
    const context = bindTransitionContext(event, definition.name)
    try {
      const checked = definition.decision(String(event.id ?? ""), decision, 0)
      return context.intent("decide", (at) => ({ ...checked, at }))
    } catch (error) {
      return context.intent("decide", (at) =>
        definition.failure(String(event.id ?? ""), error instanceof Error ? error.message : String(error), at)
      )
    }
  }
  const authority = component({
    name: definition.name,
    initial: (): State => ({ pending: HashMap.empty(), settled: HashSet.empty(), log: Chunk.empty(), next: 0 }),
    step: (state, event): State => {
      const log = options?.delegate === undefined ? state.log : Chunk.append(state.log, event)
      if (event.type === definition.decided || event.type === definition.failed) {
        const id = String(event.callId ?? "")
        return { ...state, log, pending: HashMap.remove(state.pending, id), settled: HashSet.add(state.settled, id) }
      }
      if (event.type !== definition.received) return log === state.log ? state : { ...state, log }
      const id = String(event.id ?? "")
      return HashSet.has(state.settled, id) || HashMap.has(state.pending, id)
        ? { ...state, log }
        : {
            ...state,
            log,
            next: state.next + 1,
            pending: HashMap.set(state.pending, id, { order: state.next, event })
          }
    },
    output: (state) => {
      const pending = [...HashMap.values(state.pending)].sort((a, b) => a.order - b.order).map((value) => value.event)
      const event = pending[0]
      const transitions: Array<Transition<never, Router | Self>> = []
      if (event !== undefined && options !== undefined) {
        const request = requestOf(event)
        const context = bindTransitionContext(event, definition.name)
        const fail = (error: string) => context.intent("decide", (at) => definition.failure(request.id, error, at))
        if (options.delegate !== undefined) {
          const target = authorityTarget(options.delegate, event)
          if (target === undefined) transitions.push(fail("No caller authority is available"))
          else {
            const accepted = actorInvocationContextFrom(event)
            const call = actorCall(
              Chunk.toReadonlyArray(state.log),
              {
                id: `${definition.name}/${request.id}/delegate`,
                target,
                method: definition.method,
                input: request.input,
                ...(accepted === undefined ? {} : { context: accepted })
              },
              { context, tag: "delegate" }
            )
            transitions.push(...call.transitions)
            if (call.state.status === "completed") transitions.push(complete(event, call.state.output))
            else if (call.state.status !== "pending")
              transitions.push(
                fail(call.state.status === "failed" ? call.state.error : `Authority request ${call.state.status}`)
              )
          }
        } else {
          try {
            transitions.push(complete(event, options.decide(definition.request(request))))
          } catch (error) {
            transitions.push(fail(error instanceof Error ? error.message : String(error)))
          }
        }
      }
      return {
        view: { pending: pending.map(requestOf) },
        transitions,
        interactions: {
          respond: (id: string, decision: Decision) => {
            const event = HashMap.get(state.pending, id)
            return event._tag === "Some" ? complete(event.value.event, decision) : undefined
          }
        }
      }
    }
  })
  const declared = { ...authority, keys: definition.keys }
  if (options === undefined) return externallyHandled(definition.methods[definition.method]!, declared)
  const handled = handles(definition.methods[definition.method]!, declared)
  return options.delegate === undefined
    ? handled
    : calls(options.delegate, definition.methods[definition.method]!, handled)
}
