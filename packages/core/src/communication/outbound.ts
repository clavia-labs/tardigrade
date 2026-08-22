import { Context, Effect } from "effect"
import type { ActorAddress, ProviderAddress } from "./address"
import type { Link } from "./link"
import type { MessageReceived } from "./message"

// Outbound interprets actor-to-provider links through the provider instance selected by the target address.
export class Outbound extends Context.Service<
  Outbound,
  {
    readonly send: (
      link: Link<ActorAddress, ProviderAddress>,
      message: MessageReceived
    ) => Effect.Effect<void>
  }
>()("tardigrade/Outbound") {}
