import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { Event } from "../log/event"
import { actor, validateActor } from "./definition"
import { actorRef } from "./reference"
import { actorMethod, actorMethodsOf } from "./method/definition"
import { DEFAULT_CHILD_CANCELLATION_TIMEOUT_MS } from "./method/cancellation"
import { alarmFired } from "./method/timeout"
import { calls, externallyHandled, handles, type CallerRef } from "./contract"

const component = { name: "inspect", derive: () => ({ view: undefined, transitions: [] }) }
const methods = actorMethodsOf({
  inspect: actorMethod({
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
    expect(definition.reactors).toHaveLength(3)
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
    const transitions = definition.reactors.flatMap((reactor) => reactor([{
      type: "CallDispatched",
      id: "inspect-1",
      method: "inspect",
      target: "inspector:shared",
      input: { value: "release" },
      timeoutMs: 20,
      deadlineAt: 21,
      at: 1
    }, alarmFired({ scheduledFor: 21, at: 21 })]))
    expect(transitions.some((transition) => transition.key === "mterm:inspect-1")).toBe(true)
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
