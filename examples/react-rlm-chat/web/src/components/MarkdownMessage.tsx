import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ReactElement } from "react"

export const MarkdownMessage = ({ children }: { readonly children: string }): ReactElement => (
  <Markdown remarkPlugins={[remarkGfm]} components={{
    table: ({ children }) => (
      <div className="markdown-table" role="region" aria-label="Table" tabIndex={0}>
        <table>{children}</table>
      </div>
    )
  }}>{children}</Markdown>
)
