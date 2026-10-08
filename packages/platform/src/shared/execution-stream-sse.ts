import type { ExecutionUpdate, ThreadCoordinate } from "@clavia/tardigrade-core"
import { Stream } from "effect"
import { Sse } from "effect/encoding"
import { HttpServerResponse } from "effect/http"

// executionStreamSse encodes live execution updates without advertising journal replay cursors (packages/platform/test/bun/execution-stream.test.ts).
export function executionStreamSse(execution: Stream.Stream<ExecutionUpdate>, address?: ThreadCoordinate) {
  return HttpServerResponse.stream(execution.pipe(
    Stream.filter(update => address === undefined || (update.address?.actor === address.actor && update.address.instance === address.instance && update.address.thread === address.thread)),
    Stream.map(update => Sse.encoder.write({ _tag: "Event", event: update.payload.type, id: undefined, data: JSON.stringify(update) })),
    Stream.encodeText,
  ), { contentType: "text/event-stream", headers: { "cache-control": "no-cache" } })
}
