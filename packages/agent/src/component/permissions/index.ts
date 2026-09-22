import { Chunk, HashMap, Option } from "effect"
import type { TransitionContext } from "@clavia/tardigrade-core/transition/transition"
import { authorityTarget } from "../escalate/target"
import { permissionRequestDecided, permissionRequestFailed } from "../../log/events"
import type { PermissionAuthority } from "../escalate/permission-authority"
import type { Intent } from "@clavia/tardigrade-core/intent"
import type { Event } from "@clavia/tardigrade-core/event"
import type { InvocationRef } from "@clavia/tardigrade-core/interaction/invocation"
import { threadCreatedOf } from "@clavia/tardigrade-core/interaction/relations"
import { formatThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { actorCall } from "@clavia/tardigrade-core/interaction/invoke"
import { actorInvocationContextOf } from "@clavia/tardigrade-core/interaction/invocation"
import { calls, component, type Component, type ChildOf, type ComponentReadonly, type ComponentWork, type ComponentOutput } from "@clavia/tardigrade-core/actor"
import { Router } from "@clavia/tardigrade-core/transport/router"
import { Self, type Transition } from "@clavia/tardigrade-core/runtime"
import type { AgentView } from "../view"
import { requestPermissionMethod } from "../../actor/permission"

export type PermissionAuthorityMethods = { readonly requestPermission: typeof requestPermissionMethod }

export interface PermissionSubject {
  readonly action: string
  readonly resource?: string
  readonly reason: string
  readonly timeoutMs?: number
}

export interface PermissionsOptions<V, R = never, Result = unknown> {
  readonly request: (work: ComponentWork<R, Result>, view: ComponentReadonly<V>) => PermissionSubject | undefined
  readonly onDenied: (
    reason: string,
    respond: (result: NoInfer<Result>) => Intent<never>,
    work: ComponentWork<R, Result>,
    view: ComponentReadonly<V>
  ) => Intent<never> | undefined
  readonly authority?: PermissionAuthority
}

export interface PermissionState {
  readonly permissions: ReadonlyArray<{
    readonly key: string
    readonly status: "pending" | "allowed" | "denied"
    readonly invocation?: InvocationRef
  }>
}

export interface PermissionInteractions {
  readonly escalate: (authority: PermissionAuthority) => ReadonlyArray<Transition<never, Router | Self>>
}
export type PermissionsComponent<R = never, V extends object = AgentView, Result = unknown> =
  Component<V & PermissionState, R, Result, PermissionInteractions>

interface Request {
  readonly context: TransitionContext | undefined
  readonly subject: PermissionSubject | undefined
  readonly invocation: InvocationRef | undefined
}

// permissionEscalation forwards the requests offered by a bound permission component.
export const permissionEscalation = <R, V extends object, Result>(
  child: PermissionsComponent<R, V, Result>,
  authority: PermissionAuthority
): PermissionsComponent<R | Router | Self, V, Result> =>
  calls(
    authority,
    requestPermissionMethod,
    component({
      name: "permissions.escalation",
      children: child,
      initial: () => undefined,
      step: (state) => state,

      output: (_state, child): ComponentOutput<V & PermissionState, R | Router | Self, Result, PermissionInteractions> => {
    const output = child.output();
    return { ...output, transitions: [...output.transitions, ...(output.interactions?.escalate(authority) ?? [])] };
}
    })
  )

// permissions governs child proposals through their public response contract (permissions.properties.test.ts).
export const permissions = <V extends object, R, Result, I>(
  child: Component<V, R, Result, I>,
  options: PermissionsOptions<NoInfer<V>, NoInfer<R>, NoInfer<Result>>
): PermissionsComponent<R | Router | Self, V, Result> => {
  const classify = (requests: HashMap.HashMap<string, Request>, current: ChildOf<typeof child>, context?: TransitionContext) => {
    const output = current.output()
    for (const work of output.transitions) {
      if (work.respond === undefined) continue
      const previous = Option.getOrUndefined(HashMap.get(requests, work.key))
      if (previous === undefined) {
        requests = HashMap.set(requests, work.key, {
          context,
          subject: options.request(work, output.view),
          invocation: work.invocation
        })
      } else if (previous.context === undefined && context !== undefined) {
        requests = HashMap.set(requests, work.key, { ...previous, context })
      }
    }
    return requests
  }
  const pending = component({
    name: "permissions",
    children: child,
    initial: child => ({ log: Chunk.empty<Event>(), requests: classify(HashMap.empty(), child) }),
    step: (state, event, context, child) => ({
      log: Chunk.append(state.log, event),
      requests: classify(state.requests, child, context)
    }),

    output: (state, child): ComponentOutput<V & PermissionState, R | Router | Self, Result, PermissionInteractions> => {
      const output = child.output()
      const log = Chunk.toReadonlyArray(state.log)
      const decisionId = (key: string) => `permission/${key}`
      const decisionOf = (key: string) => log.find(event => (event.type === "PermissionRequestDecided" || event.type === "PermissionRequestFailed") &&
        event.callId === decisionId(key))
      const statusOf = (key: string, request: Request): "pending" | "allowed" | "denied" => {
        if (request.subject === undefined)
          return "allowed"
        const decision = decisionOf(key)
        return decision === undefined ? "pending" : decision.granted === true ? "allowed" : "denied"
      }
      return {
        view: {
          ...output.view, permissions: [...state.requests].map(([key, request]) => ({
            key, status: statusOf(key, request),
            ...(request.invocation === undefined ? {} : { invocation: request.invocation })
          }))
        } as V & PermissionState,
        transitions: output.transitions.flatMap((work): ReadonlyArray<ComponentWork<R | Router | Self, Result>> => {
          const request = Option.getOrUndefined(HashMap.get(state.requests, work.key))
          if (work.respond === undefined) return [work]
          if (request === undefined) return []
          if (request.subject === undefined) return [work]
          const decision = decisionOf(work.key)
          if (decision === undefined)
            return []
          if (decision.granted === true)
            return [work]
          const reason = decision.type === "PermissionRequestFailed"
            ? `Permission authority failed: ${String(decision.error)}`
            : typeof decision.reason === "string" ? decision.reason : `Permission denied for ${request.subject.action}`
          const completion = options.onDenied(reason, work.respond, work, output.view)
          return completion === undefined ? [] : [completion]
        }),
        interactions: {
          escalate: (authority) => output.transitions.flatMap((work): ReadonlyArray<Transition<never, Router | Self>> => {
            const request = Option.getOrUndefined(HashMap.get(state.requests, work.key))
            if (request?.subject === undefined || request.context === undefined || decisionOf(work.key) !== undefined)
              return []
            const { subject, context, invocation } = request
            const id = decisionId(work.key)
            const turn = invocation?.id ?? ""
            const target = authorityTarget(authority, log.find(event => event.type === "MessageReceived" && event.id === turn))
            const failed = (error: string) => context.intent(`failure/${work.key}`, at => permissionRequestFailed({ callId: id, error, at }))
            if (target === undefined)
              return [failed("No caller authority is available")]
            const source = threadCreatedOf(log)?.address
            if (source === undefined)
              throw new Error("permission escalation requires the actor thread identity")
            const call = actorCall(log, {
              id: JSON.stringify([formatThreadAddress(source), id]), target, method: "requestPermission",
              ...(invocation === undefined ? {} : { context: actorInvocationContextOf(log, invocation) ?? { invocation } }),
              input: {
                request: work.key, turn, action: subject.action, reason: subject.reason,
                ...(subject.resource === undefined ? {} : { resource: subject.resource })
              },
              ...(subject.timeoutMs === undefined ? {} : { timeoutMs: subject.timeoutMs })
            }, { context, tag: `permission/${work.key}` })
            if (call.transitions.length > 0)
              return call.transitions
            if (call.state.status === "pending")
              return []
            if (call.state.status !== "completed")
              return [failed(call.state.status === "failed" ? call.state.error : `Permission request ${call.state.status}`)]
            const decision = call.state.output
            return [context.intent(`decision/${work.key}`, at => permissionRequestDecided({
              callId: id, granted: "granted" in decision,
              ...("denied" in decision && decision.reason !== undefined ? { reason: decision.reason } : {}), at
            }))]
          }),
          cancel: (cancellation) => child.output().interactions?.cancel?.(cancellation) ?? []
        }
      }
    }
  })
  return options.authority === undefined ? pending : permissionEscalation(pending, options.authority)
}
