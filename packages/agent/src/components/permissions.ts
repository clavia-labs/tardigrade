import {
  actorCall,
  calls,
  composeComponents,
  inheritComponentContract,
  type ActorRef,
  type ComponentRequirements
} from "@clavia/tardigrade-core/actor"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { Self, type Transition } from "@clavia/tardigrade-core/reconciliation"
import { AGENT_VIEW_ALGEBRA, type AgentComponent, type AgentTool } from "../runtime/composition"
import { requestPermissionMethod } from "../actor/permission"

export type PermissionAuthorityMethods = {
  readonly requestPermission: typeof requestPermissionMethod
}

export interface PermissionSubject {
  readonly action: string
  readonly resource?: string
  readonly reason: string
}

export interface PermissionCall {
  readonly callId: string
  readonly turn?: string
  readonly tool: string
  readonly arguments: unknown
}

export interface PermissionsOptions {
  readonly authority: ActorRef<PermissionAuthorityMethods>
  // request is a pure policy over one durable tool call. Reconciliation may evaluate it again.
  readonly request: (call: PermissionCall) => PermissionSubject | undefined
}

const permissionCallId = (turn: string, callId: string): string =>
  `permission/${turn}/${callId}`

const guardedTool = <R>(tool: AgentTool<R>, options: PermissionsOptions): AgentTool<R | Router | Self> => ({
  spec: tool.spec,
  serve: (pending, log, answer): ReadonlyArray<Transition<never, R | Router | Self>> => {
    const subject = options.request({
      callId: pending.callId,
      ...(pending.turn === undefined ? {} : { turn: pending.turn }),
      tool: tool.spec.name,
      arguments: pending.arguments
    })
    if (subject === undefined) return tool.serve(pending, log, answer)
    const turn = pending.turn ?? ""
    const call = actorCall(log, {
      id: permissionCallId(turn, pending.callId),
      target: options.authority,
      method: "requestPermission",
      input: {
        request: pending.callId,
        turn,
        tool: tool.spec.name,
        action: subject.action,
        ...(subject.resource === undefined ? {} : { resource: subject.resource }),
        reason: subject.reason
      }
    })
    if (call.transitions.length > 0) return call.transitions
    if (call.state.status === "pending") return []
    if (call.state.status === "failed") {
      return [answer({ error: `Permission authority failed: ${call.state.error}` })]
    }
    if ("denied" in call.state.output) {
      return [answer({
        error: call.state.output.reason === undefined
          ? `Permission denied for ${subject.action}`
          : `Permission denied for ${subject.action}: ${call.state.output.reason}`
      })]
    }
    return tool.serve(pending, log, answer)
  }
})

// permissions gates selected tools on one-shot decisions from an authority actor.
export const permissions = <
  const Cs extends ReadonlyArray<AgentComponent<never> | AgentComponent<unknown>>
>(
  components: Cs,
  options: PermissionsOptions
): AgentComponent<ComponentRequirements<Cs[number]> | Router | Self> => {
  type R = ComponentRequirements<Cs[number]>
  const combined = composeComponents("permissions.children", AGENT_VIEW_ALGEBRA, components) as AgentComponent<R>
  return calls(options.authority, requestPermissionMethod, inheritComponentContract({
    name: "permissions",
    ...(combined.keys === undefined ? {} : { keys: combined.keys }),
    derive: (log) => {
      const children = combined.derive(log)
      return {
        view: {
          ...children.view,
          tools: children.view.tools.map((tool) => guardedTool(tool as AgentTool<R>, options))
        },
        transitions: children.transitions
      }
    }
  }, combined))
}
