import { Context, Effect } from "effect"
import { createActorStore } from "@clavia/tardigrade-experimental-host"
import { Greet, greeter } from "./actors/greeter"

// openGreeter supplies an act implementation without exposing core lifecycle events to the actor.
export const openGreeter = createActorStore({
    actor: greeter,
    actorContext: () => Context.empty(),
    services: () => Greet.layer(input => Effect.succeed(`Hello, ${input.name}`)),
})
