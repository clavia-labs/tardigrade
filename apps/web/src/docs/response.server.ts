import { DEFAULT_DOC_CACHE_CONTROL } from "./cache"
import { docAt } from "./load"
import { docSource } from "./source.server"

type DocsResponseOptions = {
  readonly cacheControl?: string
}

type MediaRange = {
  readonly index: number
  readonly quality: number
  readonly subtype: string
  readonly type: string
}

const markdownPath = (pathname: string): string | undefined => {
  if (pathname.endsWith(".mdx")) return pathname.slice(0, -4)
  if (pathname.endsWith(".md")) return pathname.slice(0, -3)
  return undefined
}

const mediaRanges = (header: string | null): ReadonlyArray<MediaRange> => (header ?? "*/*").split(",").flatMap((entry, index) => {
  const [media = "", ...parameters] = entry.trim().toLowerCase().split(";")
  const [type, subtype, extra] = media.split("/")
  if (type === undefined || type.length === 0 || subtype === undefined || subtype.length === 0 || extra !== undefined) return []
  const qualityParameter = parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.startsWith("q="))
  const quality = qualityParameter === undefined ? 1 : Number(qualityParameter.slice(2))
  return [{ index, quality: Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0, subtype, type }]
})

const qualityFor = (ranges: ReadonlyArray<MediaRange>, type: string, subtype: string): number => {
  const matches = ranges.filter((range) => (range.type === "*" || range.type === type) && (range.subtype === "*" || range.subtype === subtype))
  if (matches.length === 0) return 0
  const specificity = (range: MediaRange): number => Number(range.type !== "*") + Number(range.subtype !== "*")
  return [...matches].sort((left, right) => specificity(right) - specificity(left) || left.index - right.index)[0]?.quality ?? 0
}

const wantsMarkdown = (request: Request): boolean | undefined => {
  const ranges = mediaRanges(request.headers.get("accept"))
  const markdown = qualityFor(ranges, "text", "markdown")
  const html = qualityFor(ranges, "text", "html")
  if (markdown === 0 && html === 0) return undefined
  return markdown >= html
}

const responseBody = (request: Request, value: string): string | undefined => request.method === "HEAD" ? undefined : value

export const docsResponse = (request: Request, options: DocsResponseOptions = {}): Response | undefined => {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined
  const pathname = new URL(request.url).pathname
  const explicitPath = markdownPath(pathname)
  const preference = explicitPath === undefined ? wantsMarkdown(request) : true
  if (preference === false) return undefined
  if (preference === undefined) return new Response(responseBody(request, "Not acceptable\n"), { status: 406, headers: { "content-type": "text/plain; charset=utf-8", vary: "Accept" } })
  const doc = docAt(explicitPath ?? pathname)
  const markdown = doc === undefined ? undefined : docSource(doc.source)
  if (markdown === undefined) return new Response(responseBody(request, "Document not found\n"), { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })
  return new Response(responseBody(request, markdown), {
    headers: {
      "cache-control": options.cacheControl ?? DEFAULT_DOC_CACHE_CONTROL,
      "content-type": "text/markdown; charset=utf-8",
      ...(explicitPath === undefined ? { vary: "Accept" } : {})
    }
  })
}
