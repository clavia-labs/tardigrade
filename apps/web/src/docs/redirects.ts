const redirects: Readonly<Record<string, string>> = {
  "/docs/why": "/notes/why-tardigrade",
  "/docs/why-tardigrade": "/notes/why-tardigrade",
  "/docs/forms-and-shadows": "/notes/forms-and-shadows",
  "/docs/notes": "/notes",
  "/docs/notes/why-tardigrade": "/notes/why-tardigrade",
  "/docs/notes/forms-and-shadows": "/notes/forms-and-shadows",
  "/notes/telling-forms-from-their-shadows": "/notes/forms-and-shadows",
  "/notes/telling-forms-from-the-shadows": "/notes/forms-and-shadows",
}

// docsRedirect preserves query parameters, fragments, and Markdown suffixes on moved pages.
export function docsRedirect(url: URL): string | undefined {
  const path = url.pathname.replace(/\/$/, "")
  const suffix = /\.mdx?$/.exec(path)?.[0] ?? ""
  const target = redirects[suffix ? path.slice(0, -suffix.length) : path]
  return target === undefined ? undefined : `${target}${suffix}${url.search}${url.hash}`
}
