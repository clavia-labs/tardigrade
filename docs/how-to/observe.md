How to observe a running agent: wire its spans to a collector and keep one trace across lanes.

The log is the primary record: every call, park, and terminal is an event you can read back. Spans carry what the log cannot: wall-clock time, retries that landed no event, and the shape of a slow turn. To collect the spans, hand the host a tracer. To read one trace across lanes, hold two contracts the trace data does not state: the platform stamps each persisted event with the sending span, and the reconciler links each fire to the delivery that woke it.

## Wire a tracer

`createBunHost` takes any tracer as a Layer through `telemetry`. The ready-made occupant is `otlpTelemetry`, built on the OTLP exporter effect v4 ships in core:

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

## The one-trace contract

One business event stays one trace across every lane it touches, and that property rests on a rule every platform binding must uphold: the platform stamps the sending span's context onto each event it persists, as one `traceparent` string in W3C header form, and an event already carrying one keeps it, because the first stamp is the causal one. A binding that does not stamp fragments every cross-lane trace, and nothing will say why: the traces simply arrive orphaned.

The reconciler's side of the contract is a link: `transition.fire` links to the newest carried context on the log, which reads as "the delivery that woke this work". It is an approximation: a settle serving several fresh deliveries links them to the same trigger, because a derivation reads the whole log and cannot name which events enabled it. Links, never parents: one settle serves many deliveries, and a span has one parent.

## The outcome vocabulary

Every `transition.fire` span carries an `outcome` attribute, and it is the first filter a trace query wants:

- `committed`: an event now derives the transition's key; the work is done and absorbed against retries.
- `advanced`: no key landed, but the log grew: the act recorded evidence (a send, a BlockedOn) and stopped; the settle re-derives.
- `blocked`: nothing landed and nothing was said: a park already on record or a transient failure; the platform alarm re-drives.
- `wedged`: events returned, none derives the key, none landed: the actor dies naming the transition, because a silent spin is worse than a crash.
