import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { Event } from "../log/event"
import { actor } from "./definition"
import { actorMethod, actorMethodsOf } from "./method/definition"

const component = { name: "inspect", derive: () => ({ view: undefined, transitions: [] }) }
const methods = actorMethodsOf({
  inspect: actorMethod({
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.String,
    event: ({ id, input, at }): Event => ({ type: "Inspected", id, value: input.value, at }),
    state: () => ({ status: "pending" })
  })
})

describe("actor", () => {
  test("binds a name and methods to composed components", () => {
    const definition = actor({ name: "release-analyst", methods, components: [component] })
    expect(definition.name).toBe("release-analyst")
    expect(definition.methods).toBe(methods)
    expect(definition.components).toEqual([component])
    expect(definition.reactors).toHaveLength(2)
  })

  test("refuses an invalid actor name", () => {
    expect(() => actor({ name: "Release Analyst", methods, components: [component] })).toThrow(
      "actor name must match"
    )
  })
})
