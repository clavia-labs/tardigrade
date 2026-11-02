import { docHead } from "../docs/head"
import { docsRedirect } from "../docs/redirects"
import { createFileRoute, notFound, redirect } from "@tanstack/react-router"
import type { ReactElement } from "react"

import { DocsPage } from "../docs/Docs"
import { docAt } from "../docs/load"
import { docsResponse } from "../docs/response.server"

const pathnameOf = (splat: string | undefined): string => `/docs/${splat ?? ""}`

export const Route = createFileRoute("/docs/$")({
  server: { handlers: { GET: ({ request, next }) => docsResponse(request) ?? next(), HEAD: ({ request, next }) => docsResponse(request) ?? next() } },
  beforeLoad: ({ params, location }) => {
    const target = docsRedirect(new URL(location.href, "https://tardigrade.sh"))
    if (target !== undefined) throw redirect({ href: target, statusCode: 301 })
    if (docAt(pathnameOf(params._splat)) === undefined) throw notFound()
  },
  component: DocRoute,
  head: ({ params }) => docHead(pathnameOf(params._splat))
})

function DocRoute(): ReactElement {
  const params = Route.useParams()
  return <DocsPage pathname={pathnameOf(params._splat)} />
}
