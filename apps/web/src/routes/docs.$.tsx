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
    if (doc === undefined) return {}
    const { title, description, route, socialImage, socialImageAlt } = doc.frontmatter
    return { meta: [
      { title: `${title} | Tardigrade` },
      { name: "description", content: description },
      { property: "og:title", content: `${title} | Tardigrade` },
      { property: "og:description", content: description },
      { property: "og:url", content: `https://tardigrade.sh${route}` },
      { name: "twitter:title", content: `${title} | Tardigrade` },
      { name: "twitter:description", content: description },
      ...(socialImage === undefined ? [] : [
        { property: "og:image", content: new URL(socialImage, "https://tardigrade.sh").href },
        { property: "og:image:alt", content: socialImageAlt ?? title },
        { name: "twitter:image", content: new URL(socialImage, "https://tardigrade.sh").href },
        { name: "twitter:image:alt", content: socialImageAlt ?? title }
      ])
    ] }
  }
})

function DocRoute(): ReactElement {
  const params = Route.useParams()
  return <DocsPage pathname={pathnameOf(params._splat)} />
}
