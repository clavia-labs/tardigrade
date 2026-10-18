import { expect, test } from "bun:test"
import { Schema } from "effect"
import fc from "fast-check"
import * as Grove from "@tardie/grove"

const State = Schema.Struct({ count: Schema.Int, messages: Schema.Array(Schema.Struct({ text: Schema.String })) })

test("typed edits match a JSON model through acknowledgement and reopen", () => {
  fc.assert(fc.property(fc.array(fc.string(), { maxLength: 20 }), fc.array(fc.record({ text: fc.string(), count: fc.integer(), replace: fc.boolean() }), { minLength: 1, maxLength: 30 }), fc.constantFrom(0, 256, 8192), (messages, steps, cacheBytes) => {
    const stored = new Map<string, string>()
    const storage = { scope: "typed", options: { pageItems: 2, leafBytes: 64, cacheBytes }, load: (hash: string) => { const text = stored.get(hash); if (text === undefined) throw new Error("Missing node"); return text } }
    const grove = Grove.make(storage), bound = grove.bind(State)
    const initial = { count: 0, messages: messages.map(text => ({ text })) }
    let model = structuredClone(initial), document = bound.initial(initial)
    const original = document, old = grove.reference(original.select([]))
    for (const step of steps) {
      document = document.batch(edit => {
        edit.set(["count"], step.count)
        if (step.replace) edit.set(["messages"], [{ text: step.text }])
        else edit.append(["messages"], [{ text: step.text }])
      })
      model = { count: step.count, messages: step.replace ? [{ text: step.text }] : [...model.messages, { text: step.text }] }
      const batch = grove.staging.prepare(), nodes = batch.nodes
      for (const [hash, node] of nodes) stored.set(hash, node.text)
      grove.staging.acknowledge(batch)
      expect(document.read([])).toEqual(model)
      expect(Grove.make(storage).bind(State).open(document.reference).read([])).toEqual(model)
      expect(grove.view(old, State).materialize()).toEqual(initial)
      const staged = grove.stats().stagedNodes
      expect(() => document.set(["count"], step.text as never)).toThrow()
      expect(grove.stats().stagedNodes).toBe(staged)
    }
  }), { includeErrorInReport: true, numRuns: 100 })
})

test("discard evicts arbitrary unpublished drafts without reloading committed cache entries", () => {
  fc.assert(fc.property(fc.string(), fc.string(), (committed, unpublished) => {
    fc.pre(committed !== unpublished)
    const stored = new Map<string, string>()
    const grove = Grove.make({ scope: "discard", load: hash => { const text = stored.get(hash); if (text === undefined) throw new Error("Missing node"); return text } })
    const documents = grove.bind(Schema.Struct({ text: Schema.String }))
    const original = documents.initial({ text: committed }), batch = grove.staging.prepare(), nodes = batch.nodes
    for (const [hash, node] of nodes) stored.set(hash, node.text)
    grove.staging.acknowledge(batch)
    expect(original.read([])).toEqual({ text: committed })
    const draft = documents.initial({ text: unpublished })
    expect(draft.read([])).toEqual({ text: unpublished })
    const loaded = grove.stats().loadedNodes
    grove.discard()
    expect(grove.stats().stagedNodes).toBe(0)
    expect(original.read([])).toEqual({ text: committed })
    expect(grove.stats().loadedNodes).toBe(loaded)
    expect(() => draft.read([])).toThrow("Missing node")
    grove.clear()
    expect(original.read([])).toEqual({ text: committed })
    expect(grove.stats().loadedNodes).toBe(loaded + 1)
  }), { includeErrorInReport: true, numRuns: 100 })
})

test("prepared batches preserve unrelated drafts and later entries with identical hashes", () => {
  fc.assert(fc.property(fc.string(), fc.string(), (text, laterText) => {
    const stored = new Map<string, string>()
    const storage = { scope: "staging", options: { cacheBytes: 0 }, load: (hash: string) => {
      const value = stored.get(hash)
      if (value === undefined) throw new Error("Missing node")
      return value
    } }
    const grove = Grove.make(storage), peer = Grove.make(storage)
    const documents = grove.bind(Schema.Struct({ text: Schema.String }))
    const initial = documents.initial({ text: `initial:${text}` })
    const unrelated = documents.initial({ text: `unrelated:${text}` })
    const batch = grove.staging.prepare([initial.reference])
    expect(grove.staging.prepare([unrelated.reference]).nodes.size).toBeGreaterThan(0)
    expect(() => peer.staging.acknowledge(batch)).toThrow("foreign")
    const repeated = documents.initial({ text: `initial:${text}` })
    const later = documents.initial({ text: `later:${laterText}` })
    expect(Grove.encodeReference(repeated.reference)).toBe(Grove.encodeReference(initial.reference))
    for (const [hash, node] of batch.nodes) stored.set(hash, node.text)
    grove.staging.acknowledge(batch)
    expect(() => grove.staging.acknowledge(batch)).toThrow("already acknowledged")
    for (const document of [repeated, unrelated, later]) {
      expect(grove.staging.prepare([document.reference]).nodes.size).toBeGreaterThan(0)
      expect(document.read([])).toEqual(document === repeated ? { text: `initial:${text}` } : document === unrelated ? { text: `unrelated:${text}` } : { text: `later:${laterText}` })
    }
    const final = grove.staging.prepare()
    for (const [hash, node] of final.nodes) stored.set(hash, node.text)
    grove.staging.acknowledge(final)
    expect(grove.stats().stagedNodes).toBe(0)
    expect(peer.bind(Schema.Struct({ text: Schema.String })).open(later.reference).read([])).toEqual({ text: `later:${laterText}` })
  }), { numRuns: 100, includeErrorInReport: true })
})
