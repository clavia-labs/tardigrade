import Markdown from "react-markdown"
import type { ReactElement } from "react"

export const MarkdownMessage = ({ children }: { readonly children: string }): ReactElement => (
  <Markdown>{children}</Markdown>
)
