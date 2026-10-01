import { trajectory } from "@clavia/tardigrade-experimental-agent/atoms/durable/trajectory"
import { actorContext } from "@clavia/tardigrade-experimental-agent/context"
import { Cause, Config, Console, Effect, Exit } from "effect"
import { createBunHost } from "@clavia/tardigrade-experimental-platform/bun"
import { services } from "./services"

import { meeseeks } from "./actors/meeseeks"

const run = Effect.scoped(Effect.gen(function* () {
  const host = yield* Effect.acquireRelease(createBunHost({
    actor: meeseeks,
    actorContext,
    storage: yield* Config.String("EXPERIMENTAL_STORAGE").pipe(Config.withDefault("./.tardigrade/experimental-example")),
    services: () => services,
  }), host => host.close.pipe(Effect.orDie))

  const rickMain = yield* host.allocateRootThread({ instance: "rick", name: "main" })

  yield* Console.log("Threads:", [rickMain].map(thread => thread.coordinate))

  const rickResponse = yield* rickMain.methods.message({
    text: "Design a fictional experiment to test the portal gun's power source.",
  }, { key: "portal-experiment" })

  yield* Console.log({ rickResponse })
  yield* rickMain.wait
  yield* Console.log(rickMain.get(trajectory).findLast(entry => entry.message.role === "assistant")?.message.text)
}))

if (import.meta.main) {
  const result = await Effect.runPromiseExit(run)
  if (Exit.isFailure(result)) {
    console.error(Cause.pretty(result.cause))
    process.exitCode = 1
  }
}
