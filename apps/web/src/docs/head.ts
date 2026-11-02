import { docAt } from "./load"

export const docHead = (pathname: string) => {
  const doc = docAt(pathname)
  if (doc === undefined) return {}
  const { title, description, route, socialImage, socialImageAlt } = doc.frontmatter
  return { meta: [
    { title: `${title} | Tardigrade` },
    { name: "description", content: description },
    { property: "og:title", content: `${title} | Tardigrade` },
    { property: "og:description", content: description },
    { property: "og:url", content: `https://tardigrade.sh${route}` },
    { name: "twitter:title", content: `${title} | Tardigrade` },
    { name: "twitter:description", content: description },
    ...(socialImage === undefined ? [] : [
      { property: "og:image", content: new URL(socialImage, "https://tardigrade.sh").href },
      { property: "og:image:alt", content: socialImageAlt ?? title },
      { name: "twitter:image", content: new URL(socialImage, "https://tardigrade.sh").href },
      { name: "twitter:image:alt", content: socialImageAlt ?? title }
    ])
  ] }
}
