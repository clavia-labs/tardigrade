import { createFileRoute } from "@tanstack/react-router"

import { DocsPage } from "../docs/Docs"
import { canonicalUrl } from "../docs/head"
import { docsResponse } from "../docs/response.server"

export const Route = createFileRoute("/")({
  server: { handlers: { GET: ({ request, next }) => docsResponse(request) ?? next(), HEAD: ({ request, next }) => docsResponse(request) ?? next() } },
  component: () => <DocsPage pathname="/" />,
  head: () => ({ links: [{ rel: "canonical", href: canonicalUrl("/") }] }),
})
