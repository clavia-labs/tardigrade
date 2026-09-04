import type { ComponentType } from "react"

import Cli, { frontmatter as cliFrontmatter } from "@docs/references/cli.mdx"
import cliMarkdown from "@docs/references/cli.mdx?doc-source"
import Concepts, { frontmatter as conceptsFrontmatter } from "@docs/getting-started/concepts.mdx"
import conceptsMarkdown from "@docs/getting-started/concepts.mdx?doc-source"
import Durability, { frontmatter as durabilityFrontmatter } from "@docs/explanations/durability.mdx"
import durabilityMarkdown from "@docs/explanations/durability.mdx?doc-source"
import Rlm, { frontmatter as rlmFrontmatter } from "@docs/examples/rlm.mdx"
import rlmMarkdown from "@docs/examples/rlm.mdx?doc-source"
import Bun, { frontmatter as bunFrontmatter } from "@docs/platforms/bun.mdx"
import bunMarkdown from "@docs/platforms/bun.mdx?doc-source"
import Celld, { frontmatter as celldFrontmatter } from "@docs/platforms/celld.mdx"
import celldMarkdown from "@docs/platforms/celld.mdx?doc-source"
import Cloudflare, { frontmatter as cloudflareFrontmatter } from "@docs/platforms/cloudflare.mdx"
import cloudflareMarkdown from "@docs/platforms/cloudflare.mdx?doc-source"
import Quickstart, { frontmatter as quickstartFrontmatter } from "@docs/getting-started/quickstart.mdx"
import quickstartMarkdown from "@docs/getting-started/quickstart.mdx?doc-source"
import Sdk, { frontmatter as sdkFrontmatter } from "@docs/references/sdk.mdx"
import sdkMarkdown from "@docs/references/sdk.mdx?doc-source"
import Welcome, { frontmatter as welcomeFrontmatter } from "@docs/start-here/Welcome.mdx"
import welcomeMarkdown from "@docs/start-here/Welcome.mdx?doc-source"
import Why, { frontmatter as whyFrontmatter } from "@docs/start-here/Why.mdx"
import whyMarkdown from "@docs/start-here/Why.mdx?doc-source"

type DocFrontmatter = {
  readonly title: string
  readonly description: string
  readonly route: string
  readonly section: string
  readonly sectionOrder: number
  readonly order: number
  readonly draft?: boolean | undefined
  readonly articleClass?: string | undefined
  readonly hideDescription?: boolean | undefined
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
  { default: Welcome, frontmatter: welcomeFrontmatter, markdown: welcomeMarkdown, source: "start-here/Welcome.mdx" },
  { default: Why, frontmatter: whyFrontmatter, markdown: whyMarkdown, source: "start-here/Why.mdx" },
  { default: Quickstart, frontmatter: quickstartFrontmatter, markdown: quickstartMarkdown, source: "getting-started/quickstart.mdx" },
  { default: Concepts, frontmatter: conceptsFrontmatter, markdown: conceptsMarkdown, source: "getting-started/concepts.mdx" },
  { default: Durability, frontmatter: durabilityFrontmatter, markdown: durabilityMarkdown, source: "explanations/durability.mdx" },
  { default: Bun, frontmatter: bunFrontmatter, markdown: bunMarkdown, source: "platforms/bun.mdx" },
  { default: Cloudflare, frontmatter: cloudflareFrontmatter, markdown: cloudflareMarkdown, source: "platforms/cloudflare.mdx" },
  { default: Celld, frontmatter: celldFrontmatter, markdown: celldMarkdown, source: "platforms/celld.mdx" },
  { default: Cli, frontmatter: cliFrontmatter, markdown: cliMarkdown, source: "references/cli.mdx" },
  { default: Sdk, frontmatter: sdkFrontmatter, markdown: sdkMarkdown, source: "references/sdk.mdx" },
  { default: Rlm, frontmatter: rlmFrontmatter, markdown: rlmMarkdown, source: "examples/rlm.mdx" }
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
    articleClass,
    hideDescription
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
  docs.find((doc) => doc.frontmatter.route === (pathname === "/docs" ? DEFAULT_DOC_ROUTE : pathname))
