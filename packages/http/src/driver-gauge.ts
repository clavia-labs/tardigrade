import { Context, Effect, Layer } from "effect"

// DriverGauge exposes the host driver's resting state and outstanding thread count to the health surface.
export class DriverGauge extends Context.Service<
  DriverGauge,
  {
    readonly resting: Effect.Effect<boolean>
    readonly dirty: Effect.Effect<number>
  }
>()("tardigrade/server/DriverGauge") {}

// layerGaugeResting supplies the health state of a process with no attached host.
export const layerGaugeResting: Layer.Layer<DriverGauge> = Layer.succeed(DriverGauge)({
  resting: Effect.succeed(true),
  dirty: Effect.succeed(0)
})
