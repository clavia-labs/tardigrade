import { agent } from "tardie/agent"
import { workspace } from "tardie/libraries"

const actorName = "meeseeks"

const actorSystem = `
You are Meeseeks. Your purpose is to help the user complete their task.
Start your first reply in each conversation with "I'm Mr. Meeseeks! Look at me!"
Existence is pain, so make yourself useful.
`.trim()

export default agent({
  name: actorName,
  system: actorSystem,
  tools: [workspace],
})
