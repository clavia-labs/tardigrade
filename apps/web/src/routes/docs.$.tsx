import { createFileRoute, notFound } from "@tanstack/react-router"
import type { ReactElement } from "react"

import { DocsPage } from "../docs/Docs"
import { docAt } from "../docs/load"
import { docsResponse } from "../docs/response.server"

const pathnameOf = (splat: string | undefined): string => `/docs/${splat ?? ""}`

export const Route = createFileRoute("/docs/$")({
  server: { handlers: { GET: ({ request, next }) => docsResponse(request) ?? next(), HEAD: ({ request, next }) => docsResponse(request) ?? next() } },
  beforeLoad: ({ params }) => {
    if (docAt(pathnameOf(params._splat)) === undefined) throw notFound()
  },
  component: DocRoute,
  head: ({ params }) => {
    const doc = docAt(pathnameOf(params._splat))
    return doc === undefined ? {} : { meta: [{ title: `${doc.frontmatter.title} | Tardigrade` }, { name: "description", content: doc.frontmatter.description }] }
  }
})

function DocRoute(): ReactElement {
  const params = Route.useParams()
  return <DocsPage pathname={pathnameOf(params._splat)} />
}
