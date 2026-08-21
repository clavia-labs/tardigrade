import { ACTOR_NAME_PATTERN } from "tardie"

export interface ActorTemplateOptions {
  readonly name: string
  readonly instructions?: string
}

export const defaultActorInstructions = (name: string): string =>
  [
    `You are ${name}, a focused research agent.`,
    "",
    "Investigate the user's request carefully.",
    "Use project files as evidence.",
    "Delegate independent research when it helps.",
    "Return a concise answer with concrete findings."
  ].join("\n")

const templateLiteralOf = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${")

export const actorTemplate = (options: ActorTemplateOptions): string => {
  if (!ACTOR_NAME_PATTERN.test(options.name)) {
    throw new Error(`actor name must match ${String(ACTOR_NAME_PATTERN)}, got ${JSON.stringify(options.name)}`)
  }
  const instructions = (options.instructions ?? defaultActorInstructions(options.name)).trim()
  if (instructions.length === 0) throw new Error("actor instructions must not be blank")

  return `import {
  agentOf,
  agentsPackage,
  budget,
  codeModeFor,
  compaction,
  defineActor,
  fetchPackage,
  filesPackage,
  reply,
  workspacePackage
} from "tardie"

const instructions = {
  name: "instructions",
  system: \`
${templateLiteralOf(instructions)}
\`.trim()
}

export default defineActor({
  name: ${JSON.stringify(options.name)},
  actor: agentOf([
    instructions,
    codeModeFor({
      packages: [
        filesPackage(),
        fetchPackage(),
        agentsPackage(),
        workspacePackage()
      ]
    }),
    reply,
    budget,
    compaction
  ])
})
`
}
