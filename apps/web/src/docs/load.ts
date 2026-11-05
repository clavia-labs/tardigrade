import BuildAnAgent, { frontmatter as buildAnAgentFrontmatter } from "@docs/guides/build-an-agent.mdx"
import buildAnAgentMarkdown from "@docs/guides/build-an-agent.mdx?doc-source"
import Atoms, { frontmatter as atomsFrontmatter } from "@docs/concepts/atoms.mdx"
import atomsMarkdown from "@docs/concepts/atoms.mdx?doc-source"
import NotesIndex, { frontmatter as notesIndexFrontmatter } from "@docs/notes/index.mdx"
import notesIndexMarkdown from "@docs/notes/index.mdx?doc-source"
import Agent, { frontmatter as agentFrontmatter } from "@docs/agent.mdx"
import FormsAndShadows, { frontmatter as formsAndShadowsNote } from "@notes/telling-forms-from-their-shadows.mdx"
import formsAndShadowsMarkdown from "@notes/telling-forms-from-their-shadows.mdx?doc-source"
import agentMarkdown from "@docs/agent.mdx?doc-source"
import type { ComponentType } from "react"

import ActorChecking, { frontmatter as actorCheckingFrontmatter } from "@docs/references/actor-checking.mdx"
import actorCheckingMarkdown from "@docs/references/actor-checking.mdx?doc-source"
import Cli, { frontmatter as cliFrontmatter } from "@docs/references/cli.mdx"
import cliMarkdown from "@docs/references/cli.mdx?doc-source"
import Actors, { frontmatter as actorsFrontmatter } from "@docs/concepts/actors.mdx"
import actorsMarkdown from "@docs/concepts/actors.mdx?doc-source"
import VerifyingActors, { frontmatter as verifyingActorsFrontmatter } from "@docs/concepts/verifying-actors.mdx"
import verifyingActorsMarkdown from "@docs/concepts/verifying-actors.mdx?doc-source"
import Rlm, { frontmatter as rlmFrontmatter } from "@docs/examples/rlm.mdx"
import rlmMarkdown from "@docs/examples/rlm.mdx?doc-source"
import Boxd, { frontmatter as boxdFrontmatter } from "@docs/platforms/boxd.mdx"
import boxdMarkdown from "@docs/platforms/boxd.mdx?doc-source"
import Bun, { frontmatter as bunFrontmatter } from "@docs/platforms/bun.mdx"
import bunMarkdown from "@docs/platforms/bun.mdx?doc-source"
import Celld, { frontmatter as celldFrontmatter } from "@docs/platforms/celld.mdx"
import celldMarkdown from "@docs/platforms/celld.mdx?doc-source"
import Cloudflare, { frontmatter as cloudflareFrontmatter } from "@docs/platforms/cloudflare.mdx"
import cloudflareMarkdown from "@docs/platforms/cloudflare.mdx?doc-source"
import Sdk, { frontmatter as sdkFrontmatter } from "@docs/references/sdk.mdx"
import sdkMarkdown from "@docs/references/sdk.mdx?doc-source"
import Welcome, { frontmatter as welcomeFrontmatter } from "@docs/introduction.mdx"
import welcomeMarkdown from "@docs/introduction.mdx?doc-source"
import Why, { frontmatter as whyFrontmatter } from "@docs/notes/why-tardigrade.mdx"
import whyMarkdown from "@docs/notes/why-tardigrade.mdx?doc-source"
import StateInitialisation, { frontmatter as stateInitialisationFrontmatter } from "@docs/migration/state-initialisation.mdx"
import stateInitialisationMarkdown from "@docs/migration/state-initialisation.mdx?doc-source"

type DocFrontmatter = {
  readonly title: string
  readonly description: string
  readonly route: string
  readonly section: string
  readonly sectionOrder: number
  readonly order: number
  readonly draft?: boolean | undefined
  readonly deprecated?: boolean | undefined
  readonly articleClass?: string | undefined
  readonly hideDescription?: boolean | undefined
  readonly socialImage?: string | undefined
  readonly socialImageAlt?: string | undefined
}

export type Doc = {
  readonly Content: ComponentType
  readonly frontmatter: DocFrontmatter
  readonly markdown: string
  readonly source: string
}

type DocModule = {
  readonly default: ComponentType
  readonly frontmatter: unknown
  readonly markdown: string
  readonly source: string
}

const modules: ReadonlyArray<DocModule> = [
  { default: BuildAnAgent, frontmatter: buildAnAgentFrontmatter, markdown: buildAnAgentMarkdown, source: "guides/build-an-agent.mdx" },
  { default: Atoms, frontmatter: atomsFrontmatter, markdown: atomsMarkdown, source: "concepts/atoms.mdx" },
  { default: NotesIndex, frontmatter: notesIndexFrontmatter, markdown: notesIndexMarkdown, source: "notes/index.mdx" },
  { default: Agent, frontmatter: agentFrontmatter, markdown: agentMarkdown, source: "agent.mdx" },
  {
    default: FormsAndShadows,
    frontmatter: formsAndShadowsNote,
    markdown: formsAndShadowsMarkdown,
    source: "../notes/telling-forms-from-their-shadows.mdx",
  },
  { default: ActorChecking, frontmatter: actorCheckingFrontmatter, markdown: actorCheckingMarkdown, source: "references/actor-checking.mdx" },
  { default: Welcome, frontmatter: welcomeFrontmatter, markdown: welcomeMarkdown, source: "introduction.mdx" },
  { default: Why, frontmatter: whyFrontmatter, markdown: whyMarkdown, source: "notes/why-tardigrade.mdx" },
  { default: Actors, frontmatter: actorsFrontmatter, markdown: actorsMarkdown, source: "concepts/actors.mdx" },
  { default: VerifyingActors, frontmatter: verifyingActorsFrontmatter, markdown: verifyingActorsMarkdown, source: "concepts/verifying-actors.mdx" },
  { default: Bun, frontmatter: bunFrontmatter, markdown: bunMarkdown, source: "platforms/bun.mdx" },
  { default: Cloudflare, frontmatter: cloudflareFrontmatter, markdown: cloudflareMarkdown, source: "platforms/cloudflare.mdx" },
  { default: Celld, frontmatter: celldFrontmatter, markdown: celldMarkdown, source: "platforms/celld.mdx" },
  { default: Boxd, frontmatter: boxdFrontmatter, markdown: boxdMarkdown, source: "platforms/boxd.mdx" },
  { default: Cli, frontmatter: cliFrontmatter, markdown: cliMarkdown, source: "references/cli.mdx" },
  { default: Sdk, frontmatter: sdkFrontmatter, markdown: sdkMarkdown, source: "references/sdk.mdx" },
  { default: Rlm, frontmatter: rlmFrontmatter, markdown: rlmMarkdown, source: "examples/rlm.mdx" },
  { default: StateInitialisation, frontmatter: stateInitialisationFrontmatter, markdown: stateInitialisationMarkdown, source: "migration/state-initialisation.mdx" }
]

const stringField = (value: Record<string, unknown>, field: string, source: string): string => {
  const found = value[field]
  if (typeof found !== "string" || found.trim().length === 0) throw new Error(`${source}: frontmatter.${field} must be a non-empty string`)
  return found
}

const numberField = (value: Record<string, unknown>, field: string, source: string): number => {
  const found = value[field]
  if (typeof found !== "number" || !Number.isFinite(found)) throw new Error(`${source}: frontmatter.${field} must be a number`)
  return found
}

const readFrontmatter = (value: unknown, source: string): DocFrontmatter => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${source}: frontmatter must be an object`)
  const fields = value as Record<string, unknown>
  const route = stringField(fields, "route", source)
  if (!route.startsWith("/") || (route.length > 1 && route.endsWith("/"))) throw new Error(`${source}: frontmatter.route must start with / and omit a trailing /`)
  const articleClass = fields.articleClass
  if (articleClass !== undefined && typeof articleClass !== "string") throw new Error(`${source}: frontmatter.articleClass must be a string`)
  const draft = fields.draft
  if (draft !== undefined && typeof draft !== "boolean") throw new Error(`${source}: frontmatter.draft must be a boolean`)
  const deprecated = fields.deprecated
  if (deprecated !== undefined && typeof deprecated !== "boolean") throw new Error(`${source}: frontmatter.deprecated must be a boolean`)
  const hideDescription = fields.hideDescription
  if (hideDescription !== undefined && typeof hideDescription !== "boolean") throw new Error(`${source}: frontmatter.hideDescription must be a boolean`)
  return {
    title: stringField(fields, "title", source),
    description: stringField(fields, "description", source),
    route,
    section: stringField(fields, "section", source),
    sectionOrder: numberField(fields, "sectionOrder", source),
    order: numberField(fields, "order", source),
    draft,
    deprecated,
    articleClass,
    hideDescription,
    socialImage: fields.socialImage === undefined ? undefined : stringField(fields, "socialImage", source),
    socialImageAlt: fields.socialImageAlt === undefined ? undefined : stringField(fields, "socialImageAlt", source)
  }
}

const docs: ReadonlyArray<Doc> = modules
  .map((module) => {
    const frontmatter = readFrontmatter(module.frontmatter, module.source)
    if (frontmatter.draft === true) throw new Error(`${module.source}: draft docs cannot enter the public registry`)
    return { Content: module.default, frontmatter, markdown: module.markdown, source: module.source }
  })
  .sort((left, right) => left.frontmatter.sectionOrder - right.frontmatter.sectionOrder || left.frontmatter.order - right.frontmatter.order)

export const docPages = docs

const routes = new Set<string>()
for (const doc of docs) {
  if (routes.has(doc.frontmatter.route)) throw new Error(`${doc.source}: duplicate docs route ${doc.frontmatter.route}`)
  routes.add(doc.frontmatter.route)
}

export const docSections: ReadonlyArray<readonly [string, ReadonlyArray<Doc>]> = [...docs.reduce<Map<string, Array<Doc>>>((grouped, doc) => {
  const pages = grouped.get(doc.frontmatter.section) ?? []
  pages.push(doc)
  grouped.set(doc.frontmatter.section, pages)
  return grouped
}, new Map()).entries()]

export const DEFAULT_DOC_ROUTE = "/docs/welcome"

export const docAt = (pathname: string): Doc | undefined =>
  docs.find((doc) => doc.frontmatter.route === (pathname === "/" || pathname === "/docs" ? DEFAULT_DOC_ROUTE : pathname.replace(/\/$/, "")))
