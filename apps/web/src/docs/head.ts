import { DEFAULT_DOC_ROUTE, docAt } from "./load"

// The default doc is also served at the site root, which is its canonical URL.
export const canonicalUrl = (route: string): string => `https://tardigrade.sh${route === DEFAULT_DOC_ROUTE ? "/" : route}`

export const docHead = (pathname: string) => {
  const doc = docAt(pathname)
  if (doc === undefined) return {}
  const { title, description, route, socialImage, socialImageAlt } = doc.frontmatter
  return { meta: [
    { title: `${title} | Tardigrade` },
    { name: "description", content: description },
    { property: "og:title", content: `${title} | Tardigrade` },
    { property: "og:description", content: description },
    { property: "og:url", content: canonicalUrl(route) },
    { name: "twitter:title", content: `${title} | Tardigrade` },
    { name: "twitter:description", content: description },
    ...(socialImage === undefined ? [] : [
      { property: "og:image", content: new URL(socialImage, "https://tardigrade.sh").href },
      { property: "og:image:alt", content: socialImageAlt ?? title },
      { name: "twitter:image", content: new URL(socialImage, "https://tardigrade.sh").href },
      { name: "twitter:image:alt", content: socialImageAlt ?? title }
    ])
  ], links: [{ rel: "canonical", href: canonicalUrl(route) }] }
}
