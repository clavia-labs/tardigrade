import { Context, Effect } from "effect"
import { createActorStore } from "@clavia/tardigrade-core"
import { Greet, greeter } from "./agents/greeter"

// openGreeter supplies an act implementation without exposing core lifecycle events to the actor.
export const openGreeter = createActorStore({
    actor: greeter,
    actorContext: () => Context.empty(),
    services: () => Greet.layer(input => Effect.succeed(`Hello, ${input.name}`)),
})
