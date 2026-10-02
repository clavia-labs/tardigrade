import { Context, Effect } from "effect"

// Alarm persists a host wake; transaction adapters bind changes to their commit boundary.
export class Alarm extends Context.Service<Alarm, {
  readonly set: (at: number) => Effect.Effect<void, Error>
  readonly clear: Effect.Effect<void, Error>
}>()("tardigrade/Alarm") {}
