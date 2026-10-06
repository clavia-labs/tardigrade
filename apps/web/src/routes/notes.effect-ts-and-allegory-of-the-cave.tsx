import { createFileRoute } from "@tanstack/react-router"

import { NotesPostPage, post } from "../notes/Notes"

export const Route = createFileRoute("/notes/effect-ts-and-allegory-of-the-cave")({
  component: NotesPostPage,
  head: () => ({ meta: [
    { title: `${post.title} | Tardigrade` },
    { name: "description", content: post.description },
    { property: "og:title", content: post.title },
    { property: "og:description", content: post.description },
    { property: "og:url", content: `https://tardigrade.sh${post.route}` },
    { property: "og:type", content: "article" },
    { property: "og:image", content: new URL(post.socialImage, "https://tardigrade.sh").href },
    { property: "og:image:alt", content: post.socialImageAlt },
    { name: "twitter:title", content: post.title },
    { name: "twitter:description", content: post.description },
    { name: "twitter:image", content: new URL(post.socialImage, "https://tardigrade.sh").href },
    { name: "twitter:image:alt", content: post.socialImageAlt },
  ] }),
})
