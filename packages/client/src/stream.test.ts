import { describe, expect, test } from "bun:test"

import { actorThreadsStream, actorThreadsStreamUrl, CLOSED, stream, streamUrl, type EventSourceLike, type Frame } from "./stream"
import type { ActorThreadsEventRow, EventRow } from "./contract"
import type { ProblemError } from "./problem"

// The tail against a stand-in connection. Reconnection belongs to the EventSource, so what is
// asserted here is what the helper adds: where the first connection points, how a frame becomes a
// row, and what survives a drop.

// A stand-in EventSource. It reconnects the way a browser's does: an error while it still intends
// to reconnect leaves the handlers attached, and the frames that follow carry the ids the server
// resumed from.
class FakeSource implements EventSourceLike {
  onmessage: ((frame: Frame) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readyState = 1
  closed = false

  constructor(readonly url: string) {}

  send(id: number | string, data: unknown): void {
    this.onmessage?.({ lastEventId: String(id), data: typeof data === "string" ? data : JSON.stringify(data) })
  }

  drop(readyState: number): void {
    this.readyState = readyState
    this.onerror?.({})
  }

  close(): void {
    this.closed = true
    this.readyState = CLOSED
  }
}

const following = (options: { readonly after?: number } = {}) => {
  const rows: Array<EventRow> = []
  const failures: Array<ProblemError> = []
  let source: FakeSource | undefined
  const unsubscribe = stream({
    baseUrl: "http://localhost:4111",
    actor: "main",
    thread: "root",
    ...(options.after === undefined ? {} : { after: options.after }),
    onEvent: (row) => rows.push(row),
    onError: (error) => failures.push(error),
    eventSource: (url) => {
      source = new FakeSource(url)
      return source
    }
  })
  return { rows, failures, source: source!, unsubscribe }
}

describe("streamUrl", () => {
  test("the first connection carries after, and a thread id is encoded", () => {
    expect(streamUrl("http://localhost:4111/", "main", "ag/one", 40))
      .toBe("http://localhost:4111/v1/actors/main/threads/ag%2Fone/events/stream?after=40")
  })

  test("no after means the whole log", () => {
    expect(streamUrl("http://localhost:4111", "main", "root")).toBe("http://localhost:4111/v1/actors/main/threads/root/events/stream")
  })

  test("the actor threads stream carries its actor and cursor", () => {
    expect(actorThreadsStreamUrl("http://localhost:4111/", "one two", 4))
      .toBe("http://localhost:4111/v1/actors/one%20two/threads/stream?after=4")
  })
})

describe("stream", () => {
  test("a frame becomes a row numbered by its event id", () => {
    const { rows, source } = following({ after: 7 })
    expect(source.url).toContain("after=7")
    source.send(8, { type: "MessageReceived", text: "hi" })
    expect(rows).toEqual([{ seq: 8, event: { type: "MessageReceived", text: "hi" } }])
  })

  test("a resumed connection keeps feeding the same handler, numbered where it stopped", () => {
    const { failures, rows, source } = following({ after: 7 })
    source.send(8, { type: "TurnStarted" })
    // The source drops and reconnects on its own, replaying from the last id it saw. It is still
    // trying, so it is not a failure the caller has to show.
    source.drop(0)
    expect(failures).toEqual([])
    source.send(9, { type: "TurnEnded" })
    expect(rows.map((row) => row.seq)).toEqual([8, 9])
  })

  test("a frame with no readable id is not a row", () => {
    const { rows, source } = following()
    source.send("soon", { type: "TurnStarted" })
    expect(rows).toEqual([])
  })

  test("an unreadable frame is reported and the tail stays open", () => {
    const { failures, rows, source } = following()
    source.send(1, "{not json")
    source.send(2, { type: "TurnEnded" })
    expect(failures.map((failure) => failure.title)).toEqual(["Unreadable Event"])
    expect(rows.map((row) => row.seq)).toEqual([2])
  })

  test("a source that has given up is a failure the caller sees", () => {
    const { failures, source } = following()
    source.drop(CLOSED)
    expect(failures.map((failure) => failure.title)).toEqual(["Stream Closed"])
    expect(failures[0]!.detail).toContain("root")
  })

  test("the unsubscribe closes the connection", () => {
    const { source, unsubscribe } = following()
    unsubscribe()
    expect(source.closed).toBe(true)
  })
})

describe("actorThreadsStream", () => {
  test("a threads frame becomes an actor event row", () => {
    const rows: Array<ActorThreadsEventRow> = []
    let source: FakeSource | undefined
    const unsubscribe = actorThreadsStream({
      baseUrl: "http://localhost:4111",
      actor: "main",
      after: 2,
      onEvent: (row) => rows.push(row),
      eventSource: (url) => {
        source = new FakeSource(url)
        return source
      }
    })

    source!.send(3, { type: "ThreadsSnapshot", threads: [] })

    expect(source!.url).toContain("after=2")
    expect(rows).toEqual([{ seq: 3, event: { type: "ThreadsSnapshot", threads: [] } }])
    unsubscribe()
    expect(source!.closed).toBe(true)
  })
})
