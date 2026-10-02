import { actorContext } from "@clavia/tardigrade-agent/actor/context"
import { Cause, Config, Console, Effect, Exit } from "effect"
import { createBunHost } from "@clavia/tardigrade-platform/bun"
import { services } from "./services"

import { meeseeks } from "./agents/meeseeks"

const run = Effect.scoped(Effect.gen(function* () {
  const host = yield* Effect.acquireRelease(createBunHost({
    actor: meeseeks,
    actorContext,
    storage: yield* Config.String("EXPERIMENTAL_STORAGE").pipe(Config.withDefault(".tardigrade/experimental-example")),
    services: () => services,
  }), host => host.close.pipe(Effect.orDie))

  const thread = yield* host.allocateRootThread({ instance: "example", name: "main" })

  yield* Console.log("Threads:", [thread].map(thread => thread.coordinate))

  const response = yield* thread.message({
    text: yield* Config.String("EXPERIMENTAL_MESSAGE").pipe(Config.withDefault("Hello")),
  }, { id: "example-message" })

  yield* Console.log({ response })
  yield* thread.wait
}))

if (import.meta.main) {
  const result = await Effect.runPromiseExit(run)
  if (Exit.isFailure(result)) {
    console.error(Cause.pretty(result.cause))
    process.exitCode = 1
  }
}
