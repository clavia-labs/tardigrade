type MediaRange = {
  readonly index: number
  readonly quality: number
  readonly subtype: string
  readonly type: string
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

export const wantsMarkdown = (header: string | null): boolean | undefined => {
  const ranges = mediaRanges(header)
  const markdown = qualityFor(ranges, "text", "markdown")
  const html = qualityFor(ranges, "text", "html")
  if (markdown === 0 && html === 0) return undefined
  return markdown > html
}
