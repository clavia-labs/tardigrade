import type { ActorRef } from "./reference"
import type { ActorMethodDeclaration, ActorMethods } from "../method"
import type { Component } from "@clavia/tardigrade-core/component"

export const COMPONENT_CONTRACT = Symbol.for("tardigrade.component.contract")

export type MethodHandling = "local" | "external"

export interface HandledMethod {
  readonly method: ActorMethodDeclaration
  readonly handling: MethodHandling
}

export interface CallerRef<Methods extends ActorMethods = ActorMethods> {
  readonly kind: "caller"
  readonly methods: Methods
}

export interface CalledMethod {
  readonly method: ActorMethodDeclaration
  readonly target: ActorRef | CallerRef
}

// ComponentContract records method seams using the method declarations that execute them.
export interface ComponentContract {
  readonly handles: ReadonlyArray<HandledMethod>
  readonly calls: ReadonlyArray<CalledMethod>
}

export const EMPTY_COMPONENT_CONTRACT: ComponentContract = { handles: [], calls: [] }

// componentContractOf reads semantic evidence attached by a component constructor.
export const componentContractOf = <V, R>(component: Component<V, R>): ComponentContract =>
  component[COMPONENT_CONTRACT] ?? EMPTY_COMPONENT_CONTRACT

// mergeComponentContracts preserves method seams across component composition.
export const mergeComponentContracts = (
  components: ReadonlyArray<Component<unknown, unknown>>
): ComponentContract => ({
  handles: components.flatMap((component) => componentContractOf(component).handles),
  calls: components.flatMap((component) => componentContractOf(component).calls)
})

// withComponentContract adds semantic evidence to a component without changing its runtime behavior.
export const withComponentContract = <V, R>(
  component: Component<V, R>,
  contract: ComponentContract
): Component<V, R> => ({ ...component, [COMPONENT_CONTRACT]: contract })

// inheritComponentContract carries a composed child's method seams through a transparent wrapper.
export const inheritComponentContract = <V, R>(
  component: Component<V, R>,
  child: { readonly [COMPONENT_CONTRACT]?: ComponentContract }
): Component<V, R> => {
  const own = componentContractOf(component)
  const inherited = child[COMPONENT_CONTRACT] ?? EMPTY_COMPONENT_CONTRACT
  return withComponentContract(component, {
    handles: [...inherited.handles, ...own.handles],
    calls: [...inherited.calls, ...own.calls]
  })
}

// inheritComponent carries a child's method seams and cancellation obligations through a transparent wrapper.
export const inheritComponent = <V, R>(
  component: Component<V, R>,
  child: Component<unknown, R>
): Component<V, R> => {
  const own = component.machine
  const inherited = child.machine
  return inheritComponentContract({
    ...component,
    machine: {
      initial: () => ({ own: own.initial(), inherited: inherited.initial() }),
      step: (state, event) => {
        const current = state as { readonly own: unknown; readonly inherited: unknown }
        return {
          own: own.step(current.own, event),
          inherited: inherited.step(current.inherited, event)
        }
      },
      output: (state) => own.output((state as { readonly own: unknown }).own),
      ...(own.cancel === undefined && inherited.cancel === undefined
        ? {}
        : {
            cancel: (state: unknown, cancellation: Parameters<NonNullable<typeof own.cancel>>[1]) => {
              const current = state as { readonly own: unknown; readonly inherited: unknown }
              return [
                ...(inherited.cancel?.(current.inherited, cancellation) ?? []),
                ...(own.cancel?.(current.own, cancellation) ?? [])
              ]
            }
          })
    }
  }, child)
}

const updateComponentContract = <V, R>(
  component: Component<V, R>,
  update: (contract: ComponentContract) => ComponentContract
): Component<V, R> => withComponentContract(component, update(componentContractOf(component)))

// handles records that a component completes calls to a method locally.
export const handles = <V, R>(
  method: ActorMethodDeclaration,
  component: Component<V, R>
): Component<V, R> => updateComponentContract(component, (contract) => ({
  ...contract, handles: [...contract.handles, { method, handling: "local" }]
}))

// externallyHandled records that a component accepts a method whose completion comes from outside reconciliation.
export const externallyHandled = <V, R>(
  method: ActorMethodDeclaration,
  component: Component<V, R>
): Component<V, R> => updateComponentContract(component, (contract) => ({
  ...contract, handles: [...contract.handles, { method, handling: "external" }]
}))

// calls records an outgoing method dependency on a fixed actor or the current caller.
export const calls = <V, R>(
  target: CalledMethod["target"],
  method: ActorMethodDeclaration,
  component: Component<V, R>
): Component<V, R> => updateComponentContract(component, (contract) => ({
  ...contract, calls: [...contract.calls, { target, method }]
}))

export interface ActorMethodContract {
  readonly name: string
  readonly method: ActorMethodDeclaration
  readonly handling: ReadonlyArray<MethodHandling>
}

export interface ActorCallContract {
  readonly method: ActorMethodDeclaration
  readonly methodName?: string
  readonly target: CalledMethod["target"]
}

export interface ActorContract {
  readonly methods: ReadonlyArray<ActorMethodContract>
  readonly calls: ReadonlyArray<ActorCallContract>
  readonly undeclaredHandlers: ReadonlyArray<HandledMethod>
}

const nameOf = (methods: ActorMethods, method: ActorMethodDeclaration): string | undefined =>
  Object.entries(methods).find(([, candidate]) => candidate === method)?.[0]

const isCaller = (target: CalledMethod["target"]): target is CallerRef =>
  "kind" in target && target.kind === "caller"

// actorContractOf resolves component evidence against an actor's declared method surface.
export const actorContractOf = (
  methods: ActorMethods,
  components: ReadonlyArray<Component<unknown, unknown>>
): ActorContract => {
  const contract = mergeComponentContracts(components)
  return {
    methods: Object.entries(methods).map(([name, method]) => ({
      name,
      method,
      handling: contract.handles
        .filter((handled) => handled.method === method)
        .map((handled) => handled.handling)
    })),
    undeclaredHandlers: contract.handles.filter((handled) => nameOf(methods, handled.method) === undefined),
    calls: contract.calls.map((call) => {
      const methodName = nameOf(call.target.methods, call.method)
      return { ...call, ...(methodName === undefined ? {} : { methodName }) }
    })
  }
}

// actorContractErrors reports incomplete and conflicting method seams.
export const actorContractErrors = (contract: ActorContract): ReadonlyArray<string> => {
  const errors: Array<string> = []
  for (const method of contract.methods) {
    if (method.handling.length === 0) errors.push(`method ${JSON.stringify(method.name)} has no handler`)
    if (method.handling.length > 1) {
      errors.push(`method ${JSON.stringify(method.name)} has more than one handler`)
    }
  }
  if (contract.undeclaredHandlers.length > 0) {
    errors.push(`${contract.undeclaredHandlers.length} handled method(s) are absent from the actor surface`)
  }
  for (const call of contract.calls) {
    if (call.methodName === undefined) {
      errors.push(isCaller(call.target)
        ? "caller contract does not declare the called method"
        : `actor ${JSON.stringify(call.target.address.actor)} does not declare the called method`)
    }
  }
  return errors
}
