import { bindTransitionContext } from "../transition/transition"
import { eventAt } from "../event"
import { machineOf } from "../component/runtime"
import { describe, expect, expectTypeOf, test } from "bun:test"
import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { component as defineComponent, legacyComponent, withResponse, type ComponentResult } from "@clavia/tardigrade-core/component"
import { enabled } from "@clavia/tardigrade-core/runtime/reconciler"
import { actorRuntimeOf } from "../runtime/actor"
import { actor, defineActor, validateActor, type ActorDefinition } from "./definition"
import { threadTarget } from "./target"
import { actorMethod, actorMethodsOf } from "./method"
import { legacyActorMethod } from "./method-compat"
import { DEFAULT_CHILD_CANCELLATION_TIMEOUT_MS } from "../interaction/cancellation"
import { alarmFired } from "../interaction/timeout"
import { calls, externallyHandled, handles, withComponentContract, inheritComponentContract, EMPTY_COMPONENT_CONTRACT, COMPONENT_CONTRACT, type ComponentContract, type CallerRef } from "./contract"

const component = legacyComponent({ name: "inspect", derive: () => ({ view: undefined, transitions: [] }) })
const methods = actorMethodsOf({
  inspect: legacyActorMethod({
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.String,
    event: ({ invocation, input, at }): Event => ({ type: "Inspected", id: invocation.id, value: input.value, at }),
    state: () => ({ status: "pending" })
  })
})

describe("actor", () => {
  test("defineActor leaves compilation outside the public definition", () => {
    const definition = defineActor("release-analyst", methods, [component])
    expect(Object.keys(definition).sort()).toEqual(["allocateChildThread", "allocateRootThread", "cancellation", "components", "contract", "methods", "name"])
    const runtime = actorRuntimeOf(definition)
    expect(runtime).toBe(actorRuntimeOf(definition))
    expect(Object.keys(definition).sort()).toEqual(["allocateChildThread", "allocateRootThread", "cancellation", "components", "contract", "methods", "name"])
    expect(runtime).not.toBe(actorRuntimeOf(defineActor("release-analyst", methods, [component])))
    expect(enabled(runtime, [])).toEqual(enabled(definition, []))
  })

  test("references accept definitions without runtime assembly", () => {
    const definition: ActorDefinition<typeof methods> = {
      name: "release-analyst",
      methods,
      components: [component]
    }
    expect(threadTarget(definition, "main", "shared")).toEqual({
      coordinate: { actor: "release-analyst", instance: "main", thread: "shared" },
      address: { actor: "release-analyst", instance: "main", thread: "shared" },
      methods
    })
  })

  test("binds a name and methods to composed components", () => {
    const definition = actor({ name: "release-analyst", methods, components: [component] })
    expect(definition.name).toBe("release-analyst")
    expect(definition.methods).toBe(methods)
    expect(definition.components).toEqual([component])
    expect(definition.cancellation).toEqual({ childTimeoutMs: DEFAULT_CHILD_CANCELLATION_TIMEOUT_MS })
    expect(definition).not.toHaveProperty("projections")
    expect(definition).not.toHaveProperty("projection")
    expect(definition).not.toHaveProperty("keyOf")
    expect(actorRuntimeOf(definition).projections).toHaveLength(0)
    expect(actorRuntimeOf(definition).projection).toBeDefined()
    expect(actorRuntimeOf(definition)).toBe(actorRuntimeOf(definition))
    expect(threadTarget(definition, "main", "shared")).toEqual({
      coordinate: { actor: "release-analyst", instance: "main", thread: "shared" },
      address: { actor: "release-analyst", instance: "main", thread: "shared" },
      methods
    })
  })

  test("exposes and validates the child cancellation timeout", () => {
    expect(actor({
      name: "release-analyst",
      methods,
      components: [component],
      cancellation: { childTimeoutMs: 25 }
    }).cancellation).toEqual({ childTimeoutMs: 25 })
    expect(() => actor({
      name: "release-analyst",
      methods,
      components: [component],
      cancellation: { childTimeoutMs: 0 }
    })).toThrow("child cancellation timeoutMs must be a positive safe integer")
  })

  test("mounts durable method timeout behavior on every actor", () => {
    const definition = actor({ name: "release-analyst", methods, components: [component] })
    const transitions = enabled(definition, [{
      type: "CallDispatched",
      id: "inspect-1",
      method: "inspect",
      target: "inspector:main:shared",
      input: { value: "release" },
      timeoutMs: 20,
      deadlineAt: 21,
      at: 1
    }, alarmFired({ scheduledFor: 21, at: 21 })])
    expect(transitions.some((transition) => transition.key === JSON.stringify([1, "actor.deadlines", "timeout"]))).toBe(true)
  })

  test("steps each method and component projection once per event", () => {
    let methodSteps = 0
    let componentSteps = 0
    const projectedMethod = actorMethod({
      input: Schema.Void,
      output: Schema.Void,
      event: ({ invocation, at }): Event => ({ type: "Invoked", id: invocation.id, at }),
      projection: {
        initial: () => 0,
        step: (state) => {
          methodSteps += 1
          return state + 1
        },
        output: () => ({ currentEpoch: () => 0, invocationState: () => undefined })
      }
    })
    const projectedComponent = defineComponent({
      name: "projected",
      initial: () => 0,
      step: (state: number) => {
        componentSteps += 1
        return state + 1
      },
      output: () => ({ view: undefined, transitions: [] })
    })
    const definition = actor({
      name: "projected",
      methods: {
        work: projectedMethod
      },
      components: [projectedComponent]
    })
    enabled(definition, [
      { type: "One" } as Event,
      { type: "Two" } as Event,
      { type: "Three" } as Event
    ])
    expect(methodSteps).toBe(3)
    expect(componentSteps).toBe(3)
  })

  test("refuses an invalid actor name", () => {
    expect(() => actor({ name: "Release Analyst", methods, components: [component] })).toThrow(
      "actor name must match"
    )
  })

  test("validates local and external method implementations", () => {
    expect(validateActor(actor({
      name: "local",
      methods,
      components: [handles(methods.inspect, component)]
    })).contract.methods[0]?.handling).toEqual(["local"])
    expect(validateActor(actor({
      name: "manual",
      methods,
      components: [externallyHandled(methods.inspect, component)]
    })).contract.methods[0]?.handling).toEqual(["external"])
  })

  test("reports incomplete and undeclared method seams", () => {
    expect(() => validateActor(actor({ name: "missing", methods, components: [component] }))).toThrow(
      'method "inspect" has no handler'
    )
    expect(() => validateActor(actor({
      name: "hidden",
      methods: {},
      components: [handles(methods.inspect, component)]
    }))).toThrow("handled method(s) are absent from the actor surface")
  })

  test("checks fixed actor references against the exact method declaration", () => {
    const remote = actor({ name: "remote", methods: {}, components: [] })
    const dependent = actor({
      name: "dependent",
      methods: {},
      components: [calls(threadTarget(remote, "main", "shared"), methods.inspect, component)]
    })
    expect(() => validateActor(dependent)).toThrow('actor "remote" does not declare the called method')
  })

  test("resolves a caller dependency from the caller contract", () => {
    const caller: CallerRef<typeof methods> = { kind: "caller", methods }
    const dependent = actor({
      name: "dependent",
      methods: {},
      components: [calls(caller, methods.inspect, component)]
    })
    expect(validateActor(dependent).contract.calls[0]?.methodName).toBe("inspect")
  })
})


test("contract helpers preserve machine methods and concrete component fields", () => {
  const source = {
    ...defineComponent({
      name: "typed", initial: () => 0, step: (state) => state,
      output: (count) => ({
        view: { count }, transitions: [
          withResponse(bindTransitionContext(eventAt({ type: "Ready" }, 1), "typed").intent("work", { type: "Worked" }), (result: {
            readonly error: string
          }) => bindTransitionContext(eventAt({ type: "Ready" }, 1), "typed").intent("finish", { type: "Finished", result }))
        ], interactions: {
          cancel: () => []
        }
      }),

    }),
    label: "files" as const
  }
  const caller: CallerRef<typeof methods> = { kind: "caller", methods }
  const decorated = [
    withComponentContract(source, EMPTY_COMPONENT_CONTRACT),
    inheritComponentContract(source, component),
    handles(methods.inspect, source),
    externallyHandled(methods.inspect, source),
    calls(caller, methods.inspect, source)
  ] as const
  for (const result of decorated) {
    expectTypeOf<Omit<typeof result, typeof COMPONENT_CONTRACT>>().toEqualTypeOf<Omit<typeof source, typeof COMPONENT_CONTRACT>>()
    expectTypeOf<ComponentResult<typeof result>>().toEqualTypeOf<{ readonly error: string }>()
    expect(machineOf(result)).toBe(machineOf(source))
  }

})


test("contract helpers replace narrowed contract types while preserving component fields", () => {
  const source = {
    ...component,
    label: "files" as const,
    [COMPONENT_CONTRACT]: { handles: [] as const, calls: [] as const, marker: "original" as const }
  }
  const caller: CallerRef<typeof methods> = { kind: "caller", methods }
  const decorated = [
    withComponentContract(source, EMPTY_COMPONENT_CONTRACT),
    inheritComponentContract(source, component),
    handles(methods.inspect, source),
    externallyHandled(methods.inspect, source),
    calls(caller, methods.inspect, source)
  ] as const
  for (const result of decorated) {
    expectTypeOf(result[COMPONENT_CONTRACT]).toEqualTypeOf<ComponentContract>()
    expectTypeOf(result.label).toEqualTypeOf<"files">()
    expect(result.label).toBe("files")
  }
  expect(decorated[0][COMPONENT_CONTRACT]).toBe(EMPTY_COMPONENT_CONTRACT)
  expect(decorated[0][COMPONENT_CONTRACT]).not.toHaveProperty("marker")
  expect(decorated[2][COMPONENT_CONTRACT].handles).toEqual([{ method: methods.inspect, handling: "local" }])
  expect(source[COMPONENT_CONTRACT].handles).toEqual([])
})

test("managed parents preserve child keys and contracts through nested wrappers", () => {
  const child = handles(methods.inspect, {
    ...defineComponent({ name: "leaf", initial: () => undefined, step: () => undefined,
      output: () => ({ view: undefined, transitions: [] }) }),
    keys: { prefixes: ["inspected"], keyOf: (event: Event) => event.type === "Inspected" ? `inspected/${event.id}` : undefined }
  })
  const parent = defineComponent({ name: "parent", children: child, initial: () => undefined, step: () => undefined,
    output: (_state, child) => ({ ...child.output() }) })
  const outer = defineComponent({ name: "outer", children: parent, initial: () => undefined, step: () => undefined,
    output: (_state, parent) => ({ ...parent.output() }) })
  expect(outer.keys?.keyOf({ type: "Inspected", id: "a" })).toBe("inspected/a")
  expect(outer[COMPONENT_CONTRACT]?.handles).toEqual(child[COMPONENT_CONTRACT].handles)
  expect(() => validateActor(defineActor("nested", methods, [outer]))).not.toThrow()
  expect(inheritComponentContract(parent, child)[COMPONENT_CONTRACT].handles).toHaveLength(1)
  const duplicate = {
    ...defineComponent({ name: "duplicate", initial: () => undefined, step: () => undefined,
      output: () => ({ view: undefined, transitions: [] }) }),
    keys: child.keys
  }
  expect(() => defineComponent({ name: "collision", children: [child, duplicate], initial: () => undefined, step: () => undefined,
    output: () => ({ view: undefined, transitions: [] }) })).toThrow('key prefix "inspected"')
})
