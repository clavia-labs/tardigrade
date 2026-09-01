import type { ComponentType } from "react"

type DocFrontmatter = {
  readonly title: string
  readonly description: string
  readonly route: string
  readonly section: string
  readonly sectionOrder: number
  readonly order: number
  readonly draft?: boolean | undefined
  readonly articleClass?: string | undefined
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
}

const modules = import.meta.glob<DocModule>("../../../../docs/site/**/*.mdx", { eager: true })
const markdown = import.meta.glob<string>("../../../../docs/site/**/*.mdx", { eager: true, import: "default", query: "?mdx-source" })

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
  return {
    title: stringField(fields, "title", source),
    description: stringField(fields, "description", source),
    route,
    section: stringField(fields, "section", source),
    sectionOrder: numberField(fields, "sectionOrder", source),
    order: numberField(fields, "order", source),
    draft,
    articleClass
  }
}

export const docs: ReadonlyArray<Doc> = Object.entries(modules)
  .map(([source, module]) => ({ Content: module.default, frontmatter: readFrontmatter(module.frontmatter, source), markdown: markdown[source] ?? "", source }))
  .filter((doc) => doc.frontmatter.draft !== true)
  .sort((left, right) => left.frontmatter.sectionOrder - right.frontmatter.sectionOrder || left.frontmatter.order - right.frontmatter.order)

const routes = new Set<string>()
for (const doc of docs) {
  if (routes.has(doc.frontmatter.route)) throw new Error(`${doc.source}: duplicate docs route ${doc.frontmatter.route}`)
  routes.add(doc.frontmatter.route)
}

export const DEFAULT_DOC_ROUTE = "/docs/quickstart"

export const docAt = (pathname: string): Doc | undefined =>
  docs.find((doc) => doc.frontmatter.route === (pathname === "/docs" ? DEFAULT_DOC_ROUTE : pathname))
