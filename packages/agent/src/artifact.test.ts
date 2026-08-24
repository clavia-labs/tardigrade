import { describe, expect, test } from "bun:test"

import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { defineActor } from "./artifact"
import { actorMethod, actorMethodsOf } from "./method"

const actor = { reactors: [], keyOf: () => "root" }
const methods = actorMethodsOf({
  inspect: actorMethod({
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.String,
    event: ({ id, input, at }): Event => ({ type: "Inspected", id, value: input.value, at }),
    state: () => ({ status: "pending" })
  })
})

describe("defineActor", () => {
  test("keeps a portable named actor", () => {
    const definition = defineActor({ name: "release-analyst", actor, methods })
    expect(definition).toEqual({ name: "release-analyst", actor, methods })
  })

  test("refuses a name that cannot be a path or directory segment", () => {
    expect(() => defineActor({ name: "Release Analyst", actor, methods })).toThrow("actor name must match")
  })
})
