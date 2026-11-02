import { createFileRoute } from "@tanstack/react-router"

import { DocsPage } from "../docs/Docs"
import { docsResponse } from "../docs/response.server"

export const Route = createFileRoute("/notes/")({
  server: { handlers: { GET: ({ request, next }) => docsResponse(request) ?? next(), HEAD: ({ request, next }) => docsResponse(request) ?? next() } },
  component: () => <DocsPage pathname="/notes" />,
  head: () => ({ meta: [{ title: "Notes | Tardigrade" }] }),
})
