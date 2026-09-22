import type { Intent } from "@clavia/tardigrade-core/intent"
import { executionOnly } from "@clavia/tardigrade-core/transition/transition"
import type { AuthorityComponent, AuthorityRequest } from "./authority"
import type { BudgetRequestInput, BudgetDecision } from "../../actor/budget"
import type { PermissionRequestInput, PermissionDecision } from "../../actor/permission"
import { component, type Component, type ComponentOutput } from "@clavia/tardigrade-core/actor"
import { Self } from "@clavia/tardigrade-core/runtime"
import { Router } from "@clavia/tardigrade-core/transport/router"
import { escalation as budgetEscalation, type EscalationOptions } from "./budget"
import { budgetAuthority, type BudgetAuthorityOptions } from "./budget-authority"
import type { BudgetComponent, BudgetState } from "../budget/index"
import { permissionEscalation, type PermissionsComponent, type PermissionState } from "../permissions/index"
import { permissionAuthority, type PermissionAuthority, type PermissionAuthorityOptions } from "./permission-authority"
import type { AgentView } from "../view"

export type BudgetEscalationOptions = EscalationOptions & { readonly requests?: BudgetAuthorityOptions | "manual" }
export interface PermissionEscalationOptions {
  readonly authority: PermissionAuthority
  readonly requests?: PermissionAuthorityOptions | "manual"
}

export type EscalatedComponent<View, R, Result, Input, Decision> = Component<
  View & {
    readonly requests: ReadonlyArray<AuthorityRequest<Input>>
  },
  R,
  Result,
  { readonly respond: (id: string, decision: Decision) => Intent<never> | undefined }
>

const withRequests = <View extends object, R, Result, Input, Decision>(
  child: Component<View, R, Result>,
  authority: AuthorityComponent<Input, Decision, Router | Self> | undefined
): EscalatedComponent<View, R | Router | Self, Result, Input, Decision> => {
  const children = [child, ...(authority === undefined ? [] : [authority])] as const
  return component({
    name: `${child.name}.authority`,
    children,
    initial: () => undefined,
    step: (state) => state,

    output: (_state, children): ComponentOutput<View & {
      readonly requests: ReadonlyArray<AuthorityRequest<Input>>
    }, R | Router | Self, Result, {
      readonly respond: (id: string, decision: Decision) => Intent<never> | undefined
    }> => {
      const output = children[0].output()
      const incoming = children[1]?.output()
      return {
        view: { ...output.view, requests: incoming?.view.pending ?? [] } as View & {
          readonly requests: ReadonlyArray<AuthorityRequest<Input>>
        },
        transitions: [...output.transitions, ...(incoming?.transitions ?? []).map(executionOnly)],
        interactions: {
          respond: (id, decision) => incoming?.interactions?.respond(id, decision),
          cancel: (cancellation): ReadonlyArray<import("@clavia/tardigrade-core/runtime").Transition<never, R | Router | Self>> => [
            ...(children[0].output().interactions?.cancel?.(cancellation) ?? []),
            ...(children[1]?.output().interactions?.cancel?.(cancellation) ?? [])
          ]
        }
      }
    }
  })
}

function createEscalation<R, Result>(
  child: BudgetComponent<R, Result>,
  options: BudgetEscalationOptions
): EscalatedComponent<AgentView & BudgetState, R | Router | Self, Result, BudgetRequestInput, BudgetDecision>
function createEscalation<R, V extends object, Result>(
  child: PermissionsComponent<R, V, Result>,
  options: PermissionEscalationOptions
): EscalatedComponent<V & PermissionState, R | Router | Self, Result, PermissionRequestInput, PermissionDecision>
// escalate routes policy requests to an authority and optionally handles incoming requests (escalate.test.ts).
function createEscalation<R, Result>(
  child: BudgetComponent<R, Result> | PermissionsComponent<R, object, Result>,
  options: BudgetEscalationOptions | PermissionEscalationOptions
): Component<object, R | Router | Self, Result> {
  if ("budget" in child) {
    const settings = options as BudgetEscalationOptions
    const requests = settings.requests
    const authority =
      requests === undefined
        ? undefined
        : requests === "manual"
          ? budgetAuthority.manual()
          : requests.delegate === undefined
            ? budgetAuthority(requests)
            : budgetAuthority({ delegate: requests.delegate })
    return withRequests(budgetEscalation(child, settings), authority)
  }
  const settings = options as PermissionEscalationOptions
  const requests = settings.requests
  const authority =
    requests === undefined
      ? undefined
      : requests === "manual"
        ? permissionAuthority.manual()
        : requests.delegate === undefined
          ? permissionAuthority(requests)
          : permissionAuthority({ delegate: requests.delegate })
  return withRequests(permissionEscalation(child, settings.authority), authority)
}

function createAuthority(kind: "budget", options: "manual" | { readonly decide?: import("./budget-authority").DecideBudget; readonly delegate?: never }): AuthorityComponent<BudgetRequestInput, BudgetDecision>
function createAuthority(kind: "budget", options: Extract<BudgetAuthorityOptions, { readonly delegate: unknown }>): AuthorityComponent<BudgetRequestInput, BudgetDecision, Router | Self>
function createAuthority(kind: "permissions", options: "manual" | Extract<PermissionAuthorityOptions, { readonly decide: unknown }>): AuthorityComponent<PermissionRequestInput, PermissionDecision>
function createAuthority(kind: "permissions", options: Extract<PermissionAuthorityOptions, { readonly delegate: unknown }>): AuthorityComponent<PermissionRequestInput, PermissionDecision, Router | Self>
function createAuthority(kind: "budget" | "permissions", options: BudgetAuthorityOptions | PermissionAuthorityOptions | "manual") {
  if (kind === "budget") {
    const settings = options as BudgetAuthorityOptions | "manual"
    return settings === "manual" ? budgetAuthority.manual()
      : settings.delegate === undefined ? budgetAuthority(settings) : budgetAuthority({ delegate: settings.delegate })
  }
  const settings = options as PermissionAuthorityOptions | "manual"
  return settings === "manual" ? permissionAuthority.manual()
    : settings.delegate === undefined ? permissionAuthority(settings) : permissionAuthority({ delegate: settings.delegate })
}

// escalate wraps policy decisions and exposes authority-only components (authority.test.ts).
export const escalate = Object.assign(createEscalation, { authority: createAuthority })
export { caller } from "./target"

/** @deprecated Use escalate. */
export const escalation = <R, Result>(child: BudgetComponent<R, Result>, options: BudgetEscalationOptions) =>
  escalate(child, options)
export { DEFAULT_ESCALATION_TOOL, DEFAULT_EXHAUSTED_MESSAGE, DEFAULT_ESCALATION_MESSAGE } from "./budget"
export type { EscalationOptions } from "./budget"
