import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { composeKeys, EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { settleActor } from "@clavia/tardigrade-core/reconciliation"
import { messageKeys } from "@clavia/tardigrade-core/communication/message"
import { checkInput, renderShape, renderSignature } from "./contract"
import { definePackage, type Package } from "../package/definition"
import { guestBindings, Sandbox, type Bindings } from "../sandbox/service"
import { codeReactorFor } from "./reactor"
import { codeKeys } from "./events"

// The method contract: `renderSignature` folds a declared input schema into one calling line,
// and the funnel checks the args against the same schema before the method runs. The last block
// drives the real code reactor, so the refusal is proven at the one door every call crosses.

const putSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    body: { type: "string" },
    title: { type: "string" },
    kind: { type: "string" }
  },
  required: ["name", "body"]
}

describe("renderSignature", () => {
  test("flat object: required bare, optional marked", () => {
    expect(renderSignature("put", putSchema)).toBe(
      "put({name: string, body: string, title?: string, kind?: string})"
    )
  })

  test("enum renders as a union, integer as number, arrays with their item type", () => {
    const schema = {
      type: "object",
      properties: {
        status: { enum: ["pass", "fail"] },
        limit: { type: "integer" },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["status"]
    }
    expect(renderSignature("judge", schema)).toBe('judge({status: "pass" | "fail", limit?: number, tags?: string[]})')
  })

  test("a nested object renders one level deep, then flattens to `object`", () => {
    const schema = {
      type: "object",
      properties: {
        candidate: {
          type: "object",
          properties: { name: { type: "string" }, refs: { type: "object", properties: { n: { type: "number" } } } },
          required: ["name"]
        }
      },
      required: ["candidate"]
    }
    expect(renderSignature("screen", schema)).toBe("screen({candidate: {name: string, refs?: object}})")
  })

  test("no schema, a non-object schema, or an empty one renders bare", () => {
    expect(renderSignature("list", undefined)).toBe("list()")
    expect(renderSignature("list", { type: "string" })).toBe("list()")
    expect(renderSignature("list", { type: "object", properties: {} })).toBe("list()")
  })

  test("an output schema renders as a compact shape", () => {
    expect(renderShape({
      type: "object",
      properties: {
        status: { type: "number" },
        body: { type: "string" },
        handle: {
          type: "object",
          properties: { turn: { type: "string" }, round: { type: "integer" } },
          required: ["turn"]
        }
      },
      required: ["status"]
    })).toBe("{status: number, body?: string, handle?: {turn: string, round?: number}}")
    expect(renderShape(undefined)).toBe("unknown")
  })
})

describe("checkInput", () => {
  test("a conforming call passes, extra fields allowed (additionalProperties defaults open)", () => {
    expect(checkInput({ name: "a", body: "b", extra: 1 }, putSchema)).toEqual([])
  })

  test("a missing required field is named", () => {
    expect(checkInput({ name: "a" }, putSchema)).toEqual(["missing required field 'body'"])
  })

  test("absent args stand for {}: pass when nothing is required, fail when something is", () => {
    expect(checkInput(undefined, { type: "object", properties: {} })).toEqual([])
    expect(checkInput(undefined, putSchema)).toEqual([
      "missing required field 'name'",
      "missing required field 'body'"
    ])
  })

  test("a type mismatch names the path and both types", () => {
    expect(checkInput({ name: 3, body: "b" }, putSchema)).toEqual(["name must be string, got number"])
  })

  test("enum, nested paths, and array items check recursively", () => {
    const schema = {
      type: "object",
      properties: {
        status: { enum: ["pass", "fail"] },
        candidate: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["status"]
    }
    expect(checkInput({ status: "maybe", candidate: {}, tags: ["a", 2] }, schema)).toEqual([
      'status must be one of "pass", "fail"',
      "missing required field 'candidate.name'",
      "tags[1] must be string, got number"
    ])
  })

  test("no declared schema checks nothing", () => {
    expect(checkInput({ anything: true }, undefined)).toEqual([])
  })
})

// The funnel: a wrong call settles with the teaching error as its recorded result, and the
// method never runs. A conforming call runs untouched.

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: ReadonlyArray<string>
) => (...bindings: ReadonlyArray<unknown>) => Promise<unknown>

const jsSandbox = Layer.succeed(Sandbox, {
  run: (code: string, bindings: Bindings) =>
    Effect.promise(async () => {
      try {
        const scope = guestBindings(bindings)
        const names = Object.keys(scope)
        const body = new AsyncFunction(...names, code)
        return { result: await body(...names.map((name) => scope[name])) }
      } catch (e) {
        return { error: String(e) }
      }
    })
})

const memoryLog = (initial: ReadonlyArray<Event>) =>
  Layer.effect(
    EventLog,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyArray<Event>>(initial)
      return withWatermark({
        append: (events: ReadonlyArray<Event>) => Ref.update(ref, (log) => [...log, ...events]),
        read: Ref.get(ref)
      })
    })
  )

let ran: Array<unknown> = []
const notesLike: Package = definePackage({
  name: "notes",
  description: "a package with one declared method and one undeclared",
  annotations: {
    put: { readOnlyHint: false, openWorldHint: false },
    free: { readOnlyHint: true, openWorldHint: false }
  },
  docs: {
    put: {
      description: "put",
      input: putSchema,
      output: { type: "object", properties: { ok: { type: "boolean" } } }
    }
  },
  methods: {
    put: (args) => Effect.sync(() => (ran.push(args), { ok: true })),
    free: (args) => Effect.sync(() => (ran.push(args), { ok: "unchecked" }))
  }
})

const settled = async (code: string): Promise<ReadonlyArray<Event>> => {
  ran = []
  const log: Event[] = [
    { type: "MessageReceived", id: "m1", text: "go", at: 1 },
    { type: "CodeDispatched", execId: "e1", code, turn: "t1", at: 2 }
  ]
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* settleActor({ projections: [codeReactorFor({}, [notesLike])], keyOf: composeKeys(messageKeys, codeKeys) })
      return yield* Effect.flatMap(EventLog, (l) => l.read)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          memoryLog(log),
          KeyValueStore.layerMemory,
          jsSandbox
        )
      )
    ) as Effect.Effect<ReadonlyArray<Event>>
  )
}

describe("the funnel enforces a declared input", () => {
  test("a wrong call settles with the teaching error and the method never runs", async () => {
    const events = await settled('return await notes.put({ title: "x" })')
    const returned = events.find((e) => e.type === "PackageReturned") as { result?: { error?: string } }
    expect(returned.result?.error).toBe(
      "notes.put: missing required field 'name'; missing required field 'body'. " +
        "Signature: put({name: string, body: string, title?: string, kind?: string})"
    )
    expect(ran).toEqual([])
    const settledRow = events.find((e) => e.type === "CodeSettled") as { result?: unknown }
    expect(settledRow.result).toEqual({ error: expect.stringContaining("missing required field 'name'") })
  })

  test("a conforming call and an undeclared method run untouched", async () => {
    const events = await settled('return [await notes.put({ name: "a", body: "b" }), await notes.free({ junk: 1 })]')
    const settledRow = events.find((e) => e.type === "CodeSettled") as { result?: unknown }
    expect(settledRow.result).toEqual([{ ok: true }, { ok: "unchecked" }])
    expect(ran).toEqual([{ name: "a", body: "b" }, { junk: 1 }])
  })
})
