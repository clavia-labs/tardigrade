import { threadAddressOf, type ThreadAddress } from "../communication/endpoint"
import type { Actor } from "./definition"
import type { ActorMethods } from "./method"

// ActorRef identifies one callable actor thread and preserves its declared method surface.
export interface ActorRef<Methods extends ActorMethods = ActorMethods> {
  readonly address: ThreadAddress
  readonly methods: Methods
}

// actorRef binds an actor definition to one durable thread identity.
export const actorRef = <Methods extends ActorMethods>(
  actor: Pick<Actor<never, Methods>, "name" | "methods">,
  instance: string,
  thread: string
): ActorRef<Methods> => ({
  address: threadAddressOf(actor.name, instance, thread),
  methods: actor.methods
})
