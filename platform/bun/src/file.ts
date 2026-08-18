import { appendFileSync } from "node:fs"
import { Layer, Option, Tracer } from "effect"
import type { Exit } from "effect"

// fileTelemetry is the zero-infrastructure occupant of the telemetry seam: one flat NDJSON row
// per finished span, appended to `path`. The file is live while the agent runs and needs no
// listener; `clickhouse local` queries it in place with the same column names a collector's
// otel_traces table uses, so queries transfer between the two
// (host.test.ts, "fileTelemetry lands queryable rows").
//
//   clickhouse local -q "SELECT SpanName, SpanAttributes['outcome'] FROM file('spans.ndjson',
//     JSONEachRow, 'SpanName String, SpanAttributes Map(String, String)')"

class FileSpan extends Tracer.NativeSpan {
  readonly #path: string

  constructor(options: ConstructorParameters<typeof Tracer.NativeSpan>[0], path: string) {
    super(options)
    this.#path = path
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit)
    const attributes: Record<string, string> = {}
    for (const [key, value] of this.attributes) attributes[key] = String(value)
    appendFileSync(
      this.#path,
      JSON.stringify({
        Timestamp: new Date(Number(this.startTime / 1_000_000n)).toISOString(),
        TraceId: this.traceId,
        SpanId: this.spanId,
        ParentSpanId: Option.getOrUndefined(this.parent)?.spanId ?? "",
        SpanName: this.name,
        SpanKind: this.kind,
        Duration: Number(endTime - this.startTime),
        StatusCode: exit._tag === "Success" ? "Ok" : "Error",
        SpanAttributes: attributes,
        Links: this.links.map((l) => ({ TraceId: l.span.traceId, SpanId: l.span.spanId }))
      }) + "\n"
    )
  }
}

export const fileTelemetry = (path: string): Layer.Layer<never> =>
  Layer.succeed(Tracer.Tracer)(Tracer.make({ span: (options) => new FileSpan(options, path) }))
