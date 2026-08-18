import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Tracer } from "effect"
import type { Event } from "@tardigrade/core/event"
import { transition, type Actor, type Reactor } from "@tardigrade/core/actor"

import { createBunHost, type BunHostOptions } from "./host"

// The bun binding against the reference host's contract, plus the two behaviors only physics
// can show: a reopened database keeps the log, and recover() settles work a death interrupted.

const keyOf = (e: Event): string | undefined =>
  e.type === "Done" ? `dn:${String((e as { id?: unknown }).id)}` : undefined

// One reactor: every MessageReceived owes one keyed Done.
const echoReactor: Reactor = (events) =>
  events
    .filter((e) => e.type === "MessageReceived")
    .map((e) => {
      const id = String((e as { id?: unknown }).id)
      return transition({
        key: `dn:${id}`,
        input: id,
        act: (input: string) => Effect.succeed([{ type: "Done", id: input, at: 1 } as Event])
      })
    })

const echo: Actor = { reactors: [echoReactor], keyOf }

const dir = mkdtempSync(join(tmpdir(), "tardigrade-bun-"))
let n = 0
const freshPath = (): string => join(dir, `host-${n++}.sqlite`)

const options = (path: string): BunHostOptions<never> => ({
  path,
  actorFor: (lane) => (lane === "echo" ? echo : undefined),
  keyOf
})

describe("the bun host", () => {
  test("delivers, settles, and a keyed redelivery absorbs", async () => {
    const h = await createBunHost(options(freshPath()))
    await h.deliver("bun:echo", { type: "MessageReceived", id: "m1", text: "go", at: 1 } as Event)
    await h.drive()
    expect((await h.read("echo")).map((e) => e.type)).toEqual(["MessageReceived", "Done"])
    // The same keyed event again: absorbed inside the append transaction, the log does not grow.
    await h.deliver("bun:echo", { type: "Done", id: "m1", at: 2 } as Event)
    await h.drive()
    expect(await h.read("echo")).toHaveLength(2)
    // The same message id again: receiver dedup.
    await h.deliver("bun:echo", { type: "MessageReceived", id: "m1", text: "go", at: 3 } as Event)
    expect(await h.read("echo")).toHaveLength(2)
    expect(await h.resting()).toBe(true)
    await h.close()
  })

  test("refuses an unkeyed cross-lane event, identically to the reference host", async () => {
    const h = await createBunHost(options(freshPath()))
    expect(h.deliver("bun:echo", { type: "Mystery", at: 1 } as Event)).rejects.toThrow("unkeyed cross-lane event")
    await h.close()
  })

  test("a reopened database keeps the log byte for byte", async () => {
    const path = freshPath()
    const first = await createBunHost(options(path))
    await first.deliver("bun:echo", { type: "MessageReceived", id: "m1", text: "go", at: 1 } as Event)
    await first.drive()
    const before = await first.read("echo")
    await first.close()

    const second = await createBunHost(options(path))
    expect(await second.read("echo")).toEqual(before)
    expect(await second.resting()).toBe(true)
    await second.close()
  })

  test("recover() settles work a death interrupted", async () => {
    const path = freshPath()
    const first = await createBunHost(options(path))
    // The message lands; the process dies before any drive. The owed Done exists only as a
    // derivation over the surviving log.
    await first.seed("echo", [{ type: "MessageReceived", id: "m9", text: "go", at: 1 } as Event])
    expect(await first.resting()).toBe(false)
    await first.close()

    const second = await createBunHost(options(path))
    await second.recover()
    expect((await second.read("echo")).map((e) => e.type)).toEqual(["MessageReceived", "Done"])
    expect(await second.resting()).toBe(true)
    await second.close()
  })

  test("a batch appends atomically: a mid-batch key collision absorbs that row only", async () => {
    const h = await createBunHost(options(freshPath()))
    await h.seed("echo", [{ type: "Done", id: "a", at: 1 } as Event])
    await h.seed("echo", [
      { type: "Done", id: "b", at: 2 } as Event,
      { type: "Done", id: "a", at: 3 } as Event,
      { type: "Done", id: "c", at: 4 } as Event
    ])
    expect((await h.read("echo")).map((e) => String((e as { id?: unknown }).id))).toEqual(["a", "b", "c"])
    await h.close()
  })
})

describe("telemetry seam", () => {
  test("spans flow to a supplied tracer: deliver and the transition fire, keyed", async () => {
    const names: Array<{ name: string; key?: unknown; type?: unknown }> = []
    const linked: Array<{ name: string; traceId: string }> = []
    const capture = Layer.succeed(Tracer.Tracer)(
      Tracer.make({
        span(options) {
          for (const l of options.links) linked.push({ name: options.name, traceId: l.span.traceId })
          const record = (k: string, v: unknown) =>
            names.push({ name: options.name, ...(k === "key" ? { key: v } : {}), ...(k === "type" ? { type: v } : {}) })
          return {
            _tag: "Span",
            spanId: "s",
            traceId: "t",
            name: options.name,
            parent: options.parent,
            annotations: options.annotations,
            links: options.links,
            kind: options.kind,
            sampled: true,
            status: { _tag: "Started", startTime: options.startTime },
            attributes: new Map(),
            attribute: record,
            end() {},
            event() {},
            addLinks() {}
          } as never
        }
      })
    )
    const h = await createBunHost({ ...options(freshPath()), telemetry: capture })
    await h.deliver("bun:echo", { type: "MessageReceived", id: "m1", text: "go", at: 1 } as Event)
    await h.drive()
    expect(names.some((s) => s.name === "deliver" && s.type === "MessageReceived")).toBe(true)
    expect(names.some((s) => s.name === "transition.fire" && s.key === "dn:m1")).toBe(true)
    // The cross-lane seam: the delivered event carries the deliver span's context, and the
    // fire links back to it: one business event, one trace.
    const row = (await h.read("echo"))[0] as { traceparent?: string }
    expect(row.traceparent).toMatch(/^00-t-s-01$/)
    expect(linked.some((l) => l.name === "transition.fire" && l.traceId === "t")).toBe(true)
    await h.close()
  })
})
