import { Duration, Effect, Queue, Stream } from "effect"
import type { ThreadEventRow } from "@clavia/tardigrade-core/log"
import type { ActorThreadRecord } from "@clavia/tardigrade-core/actor"
import type { ActorThread, ThreadAdded, ThreadsSnapshot } from "@clavia/tardigrade-client/contract"
import type { ActorThreads } from "./threads"
import { publicThreadId } from "./thread-compat"
import type { InferenceStream } from "./inference-stream"

// DEFAULT_EVENT_LIMIT supplies the event page size when a caller omits the limit.
export const DEFAULT_EVENT_LIMIT = 200

// DEFAULT_SSE_HEARTBEAT sets the interval between idle SSE comment frames.
export const DEFAULT_SSE_HEARTBEAT = Duration.seconds(5)

// DEFAULT_INFERENCE_STREAM_BUFFER_CAPACITY bounds unread transient frames per browser connection.
export const DEFAULT_INFERENCE_STREAM_BUFFER_CAPACITY = 64

const frameOf = (seq: number, event: unknown): string => `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`

// HEARTBEAT keeps idle SSE connections active without emitting a client event.
const HEARTBEAT = ": tardigrade\n\n"

const actorThreadOf = (record: ActorThreadRecord): ActorThread => ({
  id: publicThreadId(record.thread),
  ...(record.parentThread === undefined
    ? {}
    : { parent: publicThreadId(record.parentThread) }),
  depth: record.depth
})

// openTails counts active durable SSE scopes (sse.test.ts, cancellation).
let openTails = 0

export const openStreams = (): number => openTails

interface TailOptions {
  readonly from: number
  readonly limit: number
  readonly heartbeat: Duration.Input
  readonly initial?: Effect.Effect<readonly [string, number]>
  readonly readPage: (cursor: number, limit: number) => Effect.Effect<ReadonlyArray<ThreadEventRow>>
  readonly awaitHead: (cursor: number) => Effect.Effect<number>
  readonly encodePage: (page: ReadonlyArray<ThreadEventRow>) => Effect.Effect<string>
}

const waitForHead = (
  awaitHead: TailOptions["awaitHead"],
  cursor: number,
  heartbeat: Duration.Input
) => Effect.race(
  Effect.map(awaitHead(cursor), (target) => ({ kind: "commit" as const, target })),
  Effect.as(Effect.sleep(heartbeat), { kind: "heartbeat" as const })
)

// resumableTail replays committed pages, waits at the head, and keeps an idle connection open.
const resumableTail = (options: TailOptions): Stream.Stream<Uint8Array> => {
  interface State {
    readonly cursor: number
    readonly waiting: boolean
  }
  const step = (state: State): Effect.Effect<readonly [string, State]> =>
    Effect.gen(function*() {
      let current = state
      let target: number | undefined
      for (;;) {
        if (current.waiting) {
          const wake = yield* waitForHead(options.awaitHead, current.cursor, options.heartbeat)
          if (wake.kind === "heartbeat") return [HEARTBEAT, current] as const
          target = wake.target
          current = { ...current, waiting: false }
        }
        const page = yield* options.readPage(current.cursor, options.limit)
        if (page.length > 0) {
          const frames = yield* options.encodePage(page)
          const cursor = page[page.length - 1]!.seq
          return [frames === "" ? HEARTBEAT : frames, {
            cursor,
            waiting: target !== undefined && cursor >= target
          }] as const
        }
        const wake = yield* waitForHead(options.awaitHead, current.cursor, options.heartbeat)
        if (wake.kind === "heartbeat") return [HEARTBEAT, { ...current, waiting: true }] as const
        target = wake.target
      }
    })
  const framesFrom = (cursor: number) => Stream.unfold({ cursor, waiting: false } as State, step)
  const frames = options.initial === undefined
    ? framesFrom(options.from)
    : Stream.unwrap(Effect.map(options.initial, ([frame, cursor]) =>
      Stream.succeed(frame).pipe(Stream.concat(framesFrom(cursor)))))
  return Stream.unwrap(
    Effect.as(
      Effect.acquireRelease(
        Effect.sync(() => {
          openTails += 1
        }),
        () =>
          Effect.sync(() => {
            openTails -= 1
          })
      ),
      Stream.encodeText(frames)
    )
  )
}

// eventTail streams one thread with its durable sequence as both the page cursor and SSE id.
export const eventTail = (
  readPage: ActorThreads["eventsPage"],
  awaitHead: ActorThreads["awaitHead"],
  id: string,
  from: number,
  limit: number,
  heartbeat: Duration.Input
): Stream.Stream<Uint8Array> => resumableTail({
  from,
  limit,
  heartbeat,
  readPage: (cursor, pageLimit) => readPage(id, cursor, pageLimit),
  awaitHead: (cursor) => awaitHead(id, cursor),
  encodePage: (page) => Effect.succeed(page.map(({ seq, event }) => frameOf(seq, event)).join(""))
})

export const actorThreadsTail = (
  threads: Pick<ActorThreads, "actorThreads" | "actorEventsPage" | "awaitActorHead" | "actorThread">,
  from: number | undefined,
  limit: number,
  heartbeat: Duration.Input
): Stream.Stream<Uint8Array> => {
  const initial = from === undefined
    ? Effect.map(threads.actorThreads, ({ cursor, threads: records }) => [
      frameOf(cursor, {
        type: "ThreadsSnapshot",
        threads: records.filter((record) => record.state === "registered").map(actorThreadOf)
      } satisfies ThreadsSnapshot),
      cursor
    ] as const)
    : undefined
  return resumableTail({
    from: from ?? 0,
    limit,
    heartbeat,
    ...(initial === undefined ? {} : { initial }),
    readPage: threads.actorEventsPage,
    awaitHead: threads.awaitActorHead,
    encodePage: (page) => Effect.map(
      Effect.forEach(page, ({ seq, event }) => {
        if (event.type !== "ThreadRegistered" || typeof event.thread !== "string") return Effect.succeed("")
        return Effect.map(threads.actorThread(event.thread), (record) =>
          record === undefined
            ? ""
            : frameOf(seq, { type: "ThreadAdded", thread: actorThreadOf(record) } satisfies ThreadAdded))
      }),
      (frames) => frames.join("")
    )
  })
}
export const streamCursorOf = (after: string | undefined, lastEventId: string | undefined):
  { readonly from?: number } | { readonly invalid: "after" | "last-event-id" } => {
  for (const [field, raw] of [["after", after], ["last-event-id", lastEventId]] as const) {
    if (raw !== undefined && (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(Number(raw)))) {
      return { invalid: field }
    }
  }
  const raw = lastEventId ?? after
  return raw === undefined ? {} : { from: Number(raw) }
}

export const inferenceTail = (
  inference: InferenceStream,
  actor: string,
  thread: string,
  heartbeat: Duration.Input,
  bufferCapacity: number
): Stream.Stream<Uint8Array> => {
  if (!Number.isSafeInteger(bufferCapacity) || bufferCapacity <= 0) {
    throw new Error(`inference stream buffer capacity must be a positive integer, got ${bufferCapacity}`)
  }
  return Stream.encodeText(Stream.callback<string>((queue) => Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => inference.subscribe((delta) => {
        if (delta.instance === actor && delta.thread === thread) {
          Queue.offerUnsafe(queue, `data: ${JSON.stringify(delta)}\n\n`)
        }
      })),
      (unsubscribe) => Effect.sync(unsubscribe)
    )
    Queue.offerUnsafe(queue, HEARTBEAT)
    yield* Effect.forkScoped(Effect.forever(Effect.andThen(
      Effect.sleep(heartbeat),
      Effect.sync(() => { Queue.offerUnsafe(queue, HEARTBEAT) })
    )))
  }), { bufferSize: bufferCapacity, strategy: "dropping" }))
}
