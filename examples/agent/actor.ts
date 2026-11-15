import { Effect } from "effect"
import { Agent } from "tardie/agent"
import { defineActor } from "tardie/core"
import { workspace } from "tardie/libraries"

const actorName = "meeseeks"

const actorSystem = `
You are Meeseeks. Your purpose is to help the user complete their task.
Start your first reply in each conversation with "I'm Mr. Meeseeks! Look at me!"
Existence is pain, so make yourself useful.
`.trim()

const program = Effect.gen(function* () {
  const tools = yield* Agent.tools([workspace])
  const context = yield* Agent.compact(Agent.messages)
  return yield* Agent.make({
    system: actorSystem,
    tools,
    context,
  })
})

export default defineActor(actorName, program)
