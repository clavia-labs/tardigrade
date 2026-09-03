import {
  actorCall,
  actorInvocationContextOf,
  calls,
  composeComponents,
  inheritComponentContract,
  component as defineComponent,
  type ActorRef,
  type ComponentRequirements
} from "@clavia/tardigrade-core/actor"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { Self, type Transition } from "@clavia/tardigrade-core/runtime"
import { AGENT_VIEW_ALGEBRA, type AgentComponent, type AgentTool } from "../runtime/composition"
import { requestPermissionMethod } from "../actor/permission"
import { turnEpochOf } from "@clavia/tardigrade-code/execution/turns"

export type PermissionAuthorityMethods = {
  readonly requestPermission: typeof requestPermissionMethod
}

export interface PermissionSubject {
  readonly action: string
  readonly resource?: string
  readonly reason: string
  readonly timeoutMs?: number
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
    const invocation = { method: "message", id: turn, epoch: turnEpochOf(log, turn) }
    const call = actorCall(log, {
      id: permissionCallId(turn, pending.callId),
      target: options.authority,
      method: "requestPermission",
      ...(turn === "" ? {} : {
        context: actorInvocationContextOf(log, invocation) ?? { invocation }
      }),
      input: {
        request: pending.callId,
        turn,
        tool: tool.spec.name,
        action: subject.action,
        ...(subject.resource === undefined ? {} : { resource: subject.resource }),
        reason: subject.reason
      },
      ...(subject.timeoutMs === undefined ? {} : { timeoutMs: subject.timeoutMs })
    })
    if (call.transitions.length > 0) return call.transitions
    if (call.state.status === "pending") return []
    if (call.state.status === "failed") {
      return [answer({ error: `Permission authority failed: ${call.state.error}` })]
    }
    if (call.state.status === "cancelled") {
      return [answer({ error: `Permission authority cancelled: ${call.state.reason ?? call.state.cause}` })]
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
  const machine = combined.machine
  const project = (children: ReturnType<typeof machine.output>) => ({
    view: {
      ...children.view,
      tools: children.view.tools.map((tool) => guardedTool(tool as AgentTool<R>, options))
    },
    transitions: children.transitions
  })
  const common = {
    name: "permissions",
    ...(combined.keys === undefined ? {} : { keys: combined.keys })
  }
  const component: AgentComponent<R | Router | Self> = defineComponent({
    ...common,
    initial: machine.initial,
    step: machine.step,
    cancelState: (state, cancellation) => machine.cancel?.(state, cancellation) ?? [],
    output: (state) => project(machine.output(state))
  })
  return calls(options.authority, requestPermissionMethod, inheritComponentContract(component, combined))
}
