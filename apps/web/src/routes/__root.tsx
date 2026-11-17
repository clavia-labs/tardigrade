import { HeadContent, Outlet, Scripts, createRootRoute, useRouterState } from "@tanstack/react-router"
import type { ReactElement, ReactNode } from "react"

import { SiteShell } from "../site/SiteShell"
import "katex/dist/katex.min.css"
import "../styles.css"

const THEME_SCRIPT = `const saved=localStorage.getItem("tardigrade-theme");document.documentElement.dataset.theme=saved==="dark"||(saved===null&&matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light"`

// LETTER_SCRIPT is the Letter tag; it runs synchronously in the head of every page.
const LETTER_SCRIPT = `(function(w,d){var h=null;try{var l=w.localStorage,p=JSON.parse(l.getItem("lv:vp:"+"lv_pub_9jnkid6ilifkf81ggzof3qul")||"[]"),q=(location.pathname||"/").replace(/\\/{2,}/g,"/").replace(/(.)\\/+$/,"$1");if(p.indexOf(q)>=0){w.__lvHeld=1;h=d.createElement("style");h.textContent="html{opacity:0!important}";d.head.appendChild(h)}}catch(e){}w.__lvReveal=function(){if(h&&h.parentNode)h.parentNode.removeChild(h);h=null};setTimeout(function(){if(h)w.__lvLate=1;w.__lvReveal()},300);var s=d.createElement("script");s.src="https://lettervisit.com/v.js?k=lv_pub_9jnkid6ilifkf81ggzof3qul";s.async=true;s.setAttribute("data-key","lv_pub_9jnkid6ilifkf81ggzof3qul");s.onerror=w.__lvReveal;d.head.appendChild(s)})(window,document)`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#131514" },
      { name: "description", content: "Tardigrade is a TypeScript framework for durable, modular agents." },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://tardigrade.sh/" },
      { property: "og:title", content: "Tardigrade" },
      { property: "og:description", content: "A composable harness for durable agents." },
      { property: "og:image", content: "https://tardigrade.sh/images/tardigrade-social-code-light.png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "An agent harness as a function of an event log, shown as a trajectory derived from previous points." },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Tardigrade" },
      { name: "twitter:description", content: "A composable harness for durable agents." },
      { name: "twitter:image", content: "https://tardigrade.sh/images/tardigrade-social-code-light.png" },
      { name: "twitter:image:alt", content: "An agent harness as a function of an event log, shown as a trajectory derived from previous points." },
      { title: "Tardigrade" }
    ],
    links: [
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml", sizes: "any" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Caveat:wght@500&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@500;600&family=Instrument+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600;1,700&display=swap" }
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
    <head><HeadContent /><script dangerouslySetInnerHTML={{ __html: LETTER_SCRIPT }} /><script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} /></head>
    <body>{children}<Scripts /></body>
  </html>
)
