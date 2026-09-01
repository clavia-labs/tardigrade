import { ACTOR_NAME_PATTERN } from "tardie"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

export interface ActorTemplateOptions {
  readonly name: string
  readonly instructions?: string
  readonly template?: InitTemplate
}

export const INIT_TEMPLATES = ["quickstart", "rlm"] as const
export type InitTemplate = typeof INIT_TEMPLATES[number]
export const DEFAULT_INIT_TEMPLATE: InitTemplate = "quickstart"

export const actorTemplateCandidates = (template: InitTemplate): ReadonlyArray<string> => [
  `../../examples/${template}/actor.ts`,
  `../../../examples/${template}/actor.ts`
]

const templateLiteralOf = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${")

const replaceExactlyOnce = (source: string, pattern: RegExp, replacement: string, field: string): string => {
  const matches = source.match(pattern)
  if (matches === null || matches.length !== 1) throw new Error(`actor template must contain one ${field}`)
  return source.replace(pattern, replacement)
}

export const renderActorTemplate = (source: string, options: ActorTemplateOptions): string => {
  if (!ACTOR_NAME_PATTERN.test(options.name)) {
    throw new Error(`actor name must match ${String(ACTOR_NAME_PATTERN)}, got ${JSON.stringify(options.name)}`)
  }

  let rendered = replaceExactlyOnce(
    source,
    /^const actorName = .+$/gmu,
    `const actorName = ${JSON.stringify(options.name)}`,
    "actorName declaration"
  )
  if (options.instructions === undefined) return rendered

  const instructions = options.instructions.trim()
  if (instructions.length === 0) throw new Error("actor instructions must not be blank")
  rendered = replaceExactlyOnce(
    rendered,
    /^const actorInstructions = `[\s\S]*?`\.trim\(\)$/gmu,
    `const actorInstructions = \`\n${templateLiteralOf(instructions)}\n\`.trim()`,
    "actorInstructions declaration"
  )
  return rendered
}

export const loadActorTemplate = async (candidates: ReadonlyArray<string>): Promise<string> => {
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) throw new Error(`quickstart template is missing. Looked in: ${candidates.join(", ")}`)
  return readFile(found, "utf8")
}

export const actorTemplate = async (
  options: ActorTemplateOptions,
  candidates: ReadonlyArray<string> = actorTemplateCandidates(options.template ?? DEFAULT_INIT_TEMPLATE).map((candidate) =>
    fileURLToPath(new URL(candidate, import.meta.url))
  )
): Promise<string> => renderActorTemplate(await loadActorTemplate(candidates), options)
