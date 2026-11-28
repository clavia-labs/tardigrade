import { createFileRoute } from "@tanstack/react-router"

import { DEFAULT_DOC_CACHE_CONTROL } from "../docs/cache"
import { docPages } from "../docs/load"

const ORIGIN = "https://tardigrade.sh"

const sitemap = (): string => [
  `<?xml version="1.0" encoding="UTF-8"?>`,
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
  ...["/", ...docPages.map((doc) => doc.frontmatter.route)].map((route) => `  <url><loc>${ORIGIN}${route}</loc></url>`),
  `</urlset>`,
  ""
].join("\n")

const handler = ({ request }: { readonly request: Request }): Response => new Response(request.method === "HEAD" ? undefined : sitemap(), {
  headers: { "cache-control": DEFAULT_DOC_CACHE_CONTROL, "content-type": "application/xml; charset=utf-8" }
})

export const Route = createFileRoute("/sitemap.xml")({ server: { handlers: { GET: handler, HEAD: handler } } })
