import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { component as defineComponent, legacyComponent } from "@clavia/tardigrade-core/component"
import { enabled } from "@clavia/tardigrade-core/runtime/reconciler"
import { actor, validateActor } from "./definition"
import { actorRef } from "./reference"
import { actorMethod, actorMethodsOf } from "../method/method"
import { legacyActorMethod } from "../method/legacy"
import { DEFAULT_CHILD_CANCELLATION_TIMEOUT_MS } from "../method/cancellation"
import { alarmFired } from "../method/timeout"
import { calls, externallyHandled, handles, type CallerRef } from "./contract"

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
  test("binds a name and methods to composed components", () => {
    const definition = actor({ name: "release-analyst", methods, components: [component] })
    expect(definition.name).toBe("release-analyst")
    expect(definition.methods).toBe(methods)
    expect(definition.components).toEqual([component])
    expect(definition.cancellation).toEqual({ childTimeoutMs: DEFAULT_CHILD_CANCELLATION_TIMEOUT_MS })
    expect(definition.projections).toHaveLength(0)
    expect(definition.projection).toBeDefined()
    expect(actorRef(definition, "main", "shared")).toEqual({
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
      target: "inspector:shared",
      input: { value: "release" },
      timeoutMs: 20,
      deadlineAt: 21,
      at: 1
    }, alarmFired({ scheduledFor: 21, at: 21 })])
    expect(transitions.some((transition) => transition.key === "mterm:inspect-1")).toBe(true)
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
      methods: { work: projectedMethod },
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
      components: [calls(actorRef(remote, "main", "shared"), methods.inspect, component)]
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
