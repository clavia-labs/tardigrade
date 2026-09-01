import { createFileRoute } from "@tanstack/react-router"

import { DEFAULT_DOC_CACHE_CONTROL } from "../docs/cache"

const ROBOTS = "User-agent: *\nAllow: /\n"
const handler = ({ request }: { readonly request: Request }): Response => new Response(request.method === "HEAD" ? undefined : ROBOTS, {
  headers: { "cache-control": DEFAULT_DOC_CACHE_CONTROL, "content-type": "text/plain; charset=utf-8" }
})

export const Route = createFileRoute("/robots.txt")({ server: { handlers: { GET: handler, HEAD: handler } } })
