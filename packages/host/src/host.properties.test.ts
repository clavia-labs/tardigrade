import { expect, test } from "bun:test"
import fc from "fast-check"
import { formatThreadAddress, threadAddressOf } from "@clavia/tardigrade-core/communication/endpoint"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { threadCreatedOf } from "@clavia/tardigrade-core/thread"
import { createHost } from "./host"

const ownerId = fc.stringMatching(/^[a-z][a-z0-9_-]{0,12}$/)
const threadId = fc.string({ minLength: 1, maxLength: 40 })

test("root addresses isolate logs across actors, instances, and threads while repeated addresses reuse a log", () => {
  fc.assert(fc.property(ownerId, ownerId, threadId, (actor, instance, thread) => {
    const roots = [thread, `${thread}x`]
    const owners = [actor, `${actor}x`].flatMap((actorName) =>
      [instance, `${instance}x`].map((actorInstance) => ({
        actorName,
        actorInstance,
        host: createHost({ actorName, actorInstance, actorFor: () => undefined })
      }))
    )
    const records = owners.flatMap(({ actorName, actorInstance, host }) => roots.map((thread) => {
      const address = threadAddressOf(actorName, actorInstance, thread)
      const wire = formatThreadAddress(address)
      const first: Event = { type: "MessageReceived", id: "same-call", text: wire, at: 1 }
      expect(host.self(thread)).toBe(wire)
      host.commitRoot(wire, first)
      return { host, address, wire, first }
    }))
    expect(new Set(records.map(({ wire }) => wire)).size).toBe(records.length)

    for (const { host, address, first } of records) {
      const events = host.read(address.thread)
      expect(threadCreatedOf(events)).toMatchObject({ address, depth: 0 })
      expect(events.filter((event) => event.type === "MessageReceived")).toEqual([first])
    }
    for (const [index, { host, address, wire, first }] of records.entries()) {
      host.commitRoot(formatThreadAddress({ ...address }), { ...first })
      host.commitRoot(wire, { type: "MessageReceived", id: "next-call", text: wire, at: 2 })
      for (const [otherIndex, record] of records.entries()) {
        const events = record.host.read(record.address.thread)
        expect(events.filter((event) => event.type === "ThreadCreated")).toHaveLength(1)
        expect(events.filter((event) => event.type === "MessageReceived")).toEqual([
          record.first,
          ...(otherIndex <= index
            ? [{ type: "MessageReceived", id: "next-call", text: record.wire, at: 2 }]
            : [])
        ])
      }
    }
  }))
})
