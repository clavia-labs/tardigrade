import { Layer } from "effect"
import * as Otlp from "effect/unstable/observability/Otlp"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

// The export half of the telemetry seam, batteries included: effect v4 ships the OTLP exporter
// in core, so the convenience costs no dependency. Hand the result to createBunHost's
// `telemetry`; spans (and logs and metrics) flow to any OTLP collector over JSON, batched.
// The seam still takes any tracer: this is one ready-made occupant, never the only one.
export const otlpTelemetry = (options: {
  readonly baseUrl: string
  readonly serviceName?: string
  readonly headers?: Record<string, string>
}): Layer.Layer<never> =>
  Otlp.layerJson({
    baseUrl: options.baseUrl,
    resource: { serviceName: options.serviceName ?? "tardigrade-bun" },
    ...(options.headers === undefined ? {} : { headers: options.headers })
  }).pipe(Layer.provide(FetchHttpClient.layer))
