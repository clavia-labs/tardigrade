import { ACTOR_NAME_PATTERN } from "tardie"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

export interface ActorTemplateModel {
  readonly provider: string
  readonly defaultModel: string
}

export interface ActorTemplateOptions {
  readonly name: string
  readonly model: ActorTemplateModel
  readonly instructions?: string
}

export const INSTALLED_ACTOR_TEMPLATE = "../../examples/quickstart/actor.ts"
export const REPO_ACTOR_TEMPLATE = "../../../examples/quickstart/actor.ts"
export const ACTOR_TEMPLATE_CANDIDATES: ReadonlyArray<string> = [INSTALLED_ACTOR_TEMPLATE, REPO_ACTOR_TEMPLATE]

const templateLiteralOf = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${")

const replaceExactlyOnce = (source: string, pattern: RegExp, replacement: string, field: string): string => {
  const matches = source.match(pattern)
  if (matches === null || matches.length !== 1) throw new Error(`quickstart template must contain one ${field}`)
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
  rendered = replaceExactlyOnce(
    rendered,
    /^const actorModel = .+$/gmu,
    `const actorModel = { provider: ${JSON.stringify(options.model.provider)}, default_model: ${JSON.stringify(options.model.defaultModel)} } as const`,
    "actorModel declaration"
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
  candidates: ReadonlyArray<string> = ACTOR_TEMPLATE_CANDIDATES.map((candidate) =>
    fileURLToPath(new URL(candidate, import.meta.url))
  )
): Promise<string> => renderActorTemplate(await loadActorTemplate(candidates), options)
