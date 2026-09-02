import { HeadContent, Outlet, Scripts, createRootRoute, useRouterState } from "@tanstack/react-router"
import type { ReactElement, ReactNode } from "react"

import { SiteShell } from "../App"
import "katex/dist/katex.min.css"
import "../styles.css"

const THEME_SCRIPT = `const saved=localStorage.getItem("tardigrade-theme");document.documentElement.dataset.theme=saved==="dark"||(saved===null&&matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light"`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#131514" },
      { name: "description", content: "Tardigrade is a TypeScript framework for durable, modular agents." },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://tardigrade.sh/" },
      { property: "og:title", content: "Tardie Agent" },
      { property: "og:description", content: "A composable harness for durable agents." },
      { property: "og:image", content: "https://tardigrade.sh/images/tardigrade-social-code-light.png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "A Tardie RLM researcher agent assembled from modular components." },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Tardie Agent" },
      { name: "twitter:description", content: "A composable harness for durable agents." },
      { name: "twitter:image", content: "https://tardigrade.sh/images/tardigrade-social-code-light.png" },
      { name: "twitter:image:alt", content: "A Tardie RLM researcher agent assembled from modular components." },
      { title: "Tardigrade" }
    ],
    links: [
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml", sizes: "any" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@500;600&family=Instrument+Sans:wght@400;500;600;700&display=swap" }
    ]
  }),
  component: Root
})

function Root(): ReactElement {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  return (
    <Document>
      <SiteShell pathname={pathname}><Outlet /></SiteShell>
    </Document>
  )
}

const Document = ({ children }: { readonly children: ReactNode }): ReactElement => (
  <html lang="en" suppressHydrationWarning>
    <head><HeadContent /><script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} /></head>
    <body>{children}<Scripts /></body>
  </html>
)
