How to observe a running agent: wire its spans to a collector and keep one trace across lanes.

The log is the primary record: every call, park, and terminal is an event you can read back. Spans carry what the log cannot: wall-clock time, retries that landed no event, and the shape of a slow turn. To collect them, hand the host a tracer.

## Wire a tracer

The one prerequisite is a listener that speaks OTLP over HTTP; the exporter ships in effect core, so there is nothing to install.

`createBunHost` takes any tracer as a Layer through `telemetry`. The ready-made layer is `otlpTelemetry`, on the OTLP exporter effect v4 ships in core:

```ts
import { createBunHost } from "@tardigrade/bun/host"
import { otlpTelemetry } from "@tardigrade/bun/otlp"

const host = await createBunHost({
  path: "agents.sqlite",
  actorFor,
  layersFor,
  telemetry: otlpTelemetry({ baseUrl: "http://localhost:4318", serviceName: "my-agent" })
})
```

Absent `telemetry`, every span is inert and costs nothing. Point a backend at the stream and the span inventory enumerates itself (`transition.fire`, `deliver`, `llm.react`, `package.call`, `code.run`, with GenAI semantic-convention keys on the model span).

## Traces in ClickHouse

Questions across many traces take SQL. ClickHouse does not ingest OTLP itself: the OTel Collector fronts it, and the collector's `clickhouse` exporter writes the tables. Install both as single binaries: `brew install clickhouse`, and `otelcol-contrib` from the [collector releases](https://github.com/open-telemetry/opentelemetry-collector-releases/releases). Then run `clickhouse server` and `otelcol-contrib --config=collector.yaml`, and point `otlpTelemetry` at the same 4318:

```yaml
# collector.yaml
receivers:
  otlp: { protocols: { http: { endpoint: 0.0.0.0:4318 } } }
exporters:
  clickhouse:
    endpoint: tcp://localhost:9000
    database: otel
    create_schema: true
service:
  pipelines:
    traces: { receivers: [otlp], exporters: [clickhouse] }
```

Every attribute is then one query away (`Duration` is nanoseconds; `SpanAttributes` is a Map):

```sql
SELECT SpanAttributes['key'] AS key, count() AS fires
FROM otel.otel_traces
WHERE SpanName = 'transition.fire' AND SpanAttributes['outcome'] = 'wedged'
GROUP BY key
```

## The one-trace contract

One business event stays one trace across every lane it touches. The rule that holds it: every platform binding stamps the sending span's context onto each event it persists, as one `traceparent` string in W3C header form. An event that already carries one keeps it; the first stamp is the causal one. A binding that skips the stamp fragments every cross-lane trace, and nothing says why: the traces arrive orphaned.

The reconciler's side is a link: `transition.fire` links to the newest carried context on the log, which reads as "the delivery that woke this work". This is an approximation: a settle that serves several fresh deliveries links them all to the same trigger, because a derivation reads the whole log and cannot name which events enabled it. Links, never parents: one settle serves many deliveries, and a span has one parent.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/one-trace-dark.svg">
  <img alt="The one-trace contract: the sending span stamps a traceparent on the persisted event, and transition.fire links back to it as the delivery that woke this work" src="../assets/one-trace-light.svg">
</picture>

## The outcome vocabulary

Every `transition.fire` span carries an `outcome` attribute, and it is the first filter a trace query wants:

- `committed`: an event now derives the transition's key; the work is done and absorbed against retries.
- `advanced`: no key landed, but the log grew: the act recorded evidence (a send, a BlockedOn) and stopped; the settle re-derives.
- `blocked`: nothing landed and nothing was said: a park already on record or a transient failure; the platform alarm re-drives.
- `wedged`: events returned, none derives the key, none landed: the actor dies naming the transition, because a silent spin is worse than a crash.
