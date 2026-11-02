import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react"
import { renderToString } from "katex"
import { BulbIcon, ChevronIcon } from "./icons"

export const Math = ({ expression }: { readonly expression: string }): ReactElement => (
  <div
    className="docs-math"
    dangerouslySetInnerHTML={{ __html: renderToString(expression, { displayMode: true, throwOnError: false }) }}
  />
)

export const Tip = ({ children, title }: { readonly children: ReactNode; readonly title: string }): ReactElement => (
  <details className="docs-tip">
    <summary><BulbIcon /><span>{title}</span><ChevronIcon /></summary>
    <div className="docs-tip-content">{children}</div>
  </details>
)

export const Link = ({ href, ...props }: ComponentPropsWithoutRef<"a">): ReactElement => {
  const external = href?.startsWith("https://") === true || href?.startsWith("http://") === true
  return <a href={href} {...props} {...(external ? { rel: "noopener noreferrer", target: "_blank" } : {})} />
}

export const Table = ({ children, ...props }: ComponentPropsWithoutRef<"table">): ReactElement => <div className="docs-table"><table {...props}>{children}</table></div>
