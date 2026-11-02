import { createFileRoute, redirect } from "@tanstack/react-router"

import { docsResponse } from "../docs/response.server"
import { docsRedirect } from "../docs/redirects"

export const Route = createFileRoute("/notes/telling-forms-from-their-shadows")({
  server: { handlers: { GET: ({ request, next }) => docsResponse(request) ?? next(), HEAD: ({ request, next }) => docsResponse(request) ?? next() } },
  beforeLoad: ({ location }) => {
    throw redirect({ href: docsRedirect(new URL(location.href, "https://tardigrade.sh")) ?? "/notes/forms-and-shadows", statusCode: 301 })
  },
})
