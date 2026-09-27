import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Cause, Effect, Exit } from "effect"
import { atom, defineActor } from "@clavia/tardigrade-experimental-core"
import { createBunHost } from "@clavia/tardigrade-experimental-platform/bun"
import { compact, infer, packageTools, trajectory } from "@clavia/tardigrade-experimental-agent/atoms/index"
import { message } from "@clavia/tardigrade-experimental-agent/event"
import { fetchPackage as fetch, workspace } from "@clavia/tardigrade-experimental-packages"
import { layersFor } from "./services"

const meeseeks = defineActor("meeseeks", Effect.gen(function* () {
  const system = atom("You are a helpful assistant. Keep answers concise and practical.")
  const tools = yield* packageTools([fetch(), workspace()])
  const context = yield* compact(trajectory)
  const agent = yield* infer(atom(get => ({
    system: get(system),
    tools: get(tools),
    context: get(context),
  })))
  return { atom: agent, actions: { message } }
}))

async function run() {
  const host = await createBunHost({
    actor: meeseeks,
    storage: process.env.EXPERIMENTAL_STORAGE ?? "./.tardigrade/experimental-example",
    layersFor,
  })

  try {
    const rickMain = await host.allocateRootThread({ instance: "rick", name: "main" })

    console.log("Threads:", [rickMain].map(thread => thread.coordinate))

    const rickResponse = await rickMain.methods.message({
      text: "Design a fictional experiment to test the portal gun's power source.",
    }, { key: "portal-experiment" })

    console.log({ rickResponse })
    await rickMain.wait()
    console.log(rickMain.get(trajectory).findLast(entry => entry.role === "assistant")?.text)
  } finally {
    await host.close()
  }
}

const result = await Effect.runPromiseExit(Effect.tryPromise({
  try: run,
  catch: RuntimeError.from,
}))
if (Exit.isFailure(result)) {
  console.error(Cause.pretty(result.cause))
  process.exitCode = 1
}
