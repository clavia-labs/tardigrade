import { createFileRoute } from "@tanstack/react-router"

import { DEFAULT_DOC_CACHE_CONTROL } from "../docs/cache"
import { docPages } from "../docs/load"

const llmsText = (origin: string): string => [
  "# Tardigrade",
  "",
  "> A TypeScript framework for durable, modular agents built around an immutable event log.",
  "",
  "## Documentation",
  "",
  ...docPages.map((doc) => `- [${doc.frontmatter.title}](${origin}${doc.frontmatter.route}): ${doc.frontmatter.description}`),
  ""
].join("\n")

const handler = ({ request }: { readonly request: Request }): Response => new Response(request.method === "HEAD" ? undefined : llmsText(new URL(request.url).origin), {
  headers: { "cache-control": DEFAULT_DOC_CACHE_CONTROL, "content-type": "text/markdown; charset=utf-8" }
})

export const Route = createFileRoute("/llms.txt")({ server: { handlers: { GET: handler, HEAD: handler } } })
