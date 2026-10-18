import { expect, test } from "bun:test"
import { Schema } from "effect"
import fc from "fast-check"
import { make, tree, appendOnly, keyValue, collectionSchema } from "@tardie/grove"

const Job = Schema.Struct({ text: Schema.String, items: Schema.Array(Schema.String), note: Schema.optionalKey(Schema.String) })
const State = Schema.Struct({ document: tree(Schema.Struct({ count: Schema.Int })), messages: appendOnly(Schema.Array(Schema.String)), jobs: keyValue(Job) })

test("collection vocabularies reject generated edits inside key-value entries", () => {
  fc.assert(fc.property(fc.string(), text => {
    const grove = make({ scope: "constraints", load: () => { throw new Error("Unexpected read") } })
    const document = grove.bind(State).initial({ document: { count: 0 }, messages: [], jobs: { job: { text, items: [text] } } })
    // @ts-expect-error Key-value entries require whole-value replacement.
    expect(() => document.set(["jobs", "job", "text"], text)).toThrow("whole-entry")
    // @ts-expect-error Key-value entries reject nested append operations.
    expect(() => document.append(["jobs", "job", "items"], [text])).toThrow("whole-entry")
    // @ts-expect-error Key-value entries reject nested array splices.
    expect(() => document.splice(["jobs", "job", "items"], 0, 1)).toThrow("whole-entry")
    // @ts-expect-error Key-value entries reject removal of nested optional fields.
    expect(() => document.remove(["jobs", "job", "note"])).toThrow("whole-entry")
    expect(document.set(["jobs", "job"], { text, items: [] }).read(["jobs", "job"])).toEqual({ text, items: [] })
    expect(document.remove(["jobs", "job"]).read(["jobs"])).toEqual({})
    expect(collectionSchema(State.ast)).toBe(true)
    expect(() => collectionSchema(Schema.suspend(() => State).ast)).toThrow("explicit tree")
    expect(() => collectionSchema(Schema.Union([State, Schema.Struct({ value: tree(Schema.String) })]).ast)).toThrow("explicit tree")
    expect(collectionSchema(tree(Schema.Int).annotate({ title: text }).ast)).toBe(true)
    expect(() => collectionSchema(Schema.Struct({ declared: tree(Schema.Int), undeclared: Schema.String }).ast)).toThrow("Each durable state field")
  }), { includeErrorInReport: true })
})
