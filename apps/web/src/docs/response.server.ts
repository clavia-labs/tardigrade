import { docsRedirect } from "./redirects"
import { wantsMarkdown } from "./accept"
import { DEFAULT_DOC_CACHE_CONTROL } from "./cache"
import { docAt } from "./load"

type DocsResponseOptions = {
  readonly cacheControl?: string
}

const markdownPath = (pathname: string): string | undefined => {
  if (pathname.endsWith(".mdx")) return pathname.slice(0, -4)
  if (pathname.endsWith(".md")) return pathname.slice(0, -3)
  return undefined
}

const responseBody = (request: Request, value: string): string | undefined => request.method === "HEAD" ? undefined : value

export const docsResponse = (request: Request, options: DocsResponseOptions = {}): Response | undefined => {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined
  const url = new URL(request.url)
  const target = docsRedirect(url)
  if (target !== undefined) return new Response(null, { status: 301, headers: { location: target } })
  const pathname = url.pathname
  const explicitPath = markdownPath(pathname)
  const preference = explicitPath === undefined ? wantsMarkdown(request.headers.get("accept")) : true
  if (preference === false) return undefined
  if (preference === undefined) return new Response(responseBody(request, "Not acceptable\n"), { status: 406, headers: { "content-type": "text/plain; charset=utf-8", vary: "Accept" } })
  const doc = docAt(explicitPath ?? pathname)
  const markdown = doc?.markdown
  if (markdown === undefined) return new Response(responseBody(request, "Document not found\n"), { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })
  return new Response(responseBody(request, markdown), {
    headers: {
      "cache-control": options.cacheControl ?? DEFAULT_DOC_CACHE_CONTROL,
      "content-type": "text/markdown; charset=utf-8",
      ...(explicitPath === undefined ? { vary: "Accept" } : {})
    }
  })
}
