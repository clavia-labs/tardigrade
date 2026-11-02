import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react"
import { InlineCode, textFrom } from "./Code"

type FileIconKind = "database" | "file" | "json" | "typescript"

const fileIconKindOf = (name: string): FileIconKind => {
  if (name.endsWith(".ts")) return "typescript"
  if (name.endsWith(".sqlite") || name.endsWith(".db")) return "database"
  if (/\.jsonc?$/.test(name)) return "json"
  return "file"
}

const FileIcon = ({ kind }: { readonly kind: FileIconKind }): ReactElement => {
  if (kind === "typescript") return <svg className="docs-file-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5" /><text x="3.4" y="11.8">TS</text></svg>
  if (kind === "database") return <svg className="docs-file-icon" viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="3.5" rx="5.5" ry="2.2" /><path d="M2.5 3.5v8.8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2V3.5M2.5 8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2" /></svg>
  if (kind === "json") return <svg className="docs-file-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 2.5H5.3c-1 0-1.5.5-1.5 1.5v2.1c0 .9-.4 1.4-1.3 1.4.9 0 1.3.5 1.3 1.4V12c0 1 .5 1.5 1.5 1.5h1.2M9.5 2.5h1.2c1 0 1.5.5 1.5 1.5v2.1c0 .9.4 1.4 1.3 1.4-.9 0-1.3.5-1.3 1.4V12c0 1-.5 1.5-1.5 1.5H9.5" /></svg>
  return <svg className="docs-file-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.5h6l4 4v9H3Z" /><path d="M9 1.5v4h4" /></svg>
}

const withFileIcons = (node: ReactNode): ReactNode => {
  if (Array.isArray(node)) return Children.map(node, withFileIcons)
  if (!isValidElement<{ readonly children?: ReactNode }>(node)) return node
  if (node.type === "li") {
    const children = Children.toArray(node.props.children)
    const fileIndex = children.findIndex((child) => isValidElement(child) && child.type === InlineCode)
    if (fileIndex === -1) return node
    const file = children[fileIndex] as ReactElement<{ readonly children?: ReactNode }>
    const name = textFrom(file.props.children)
    const description = children.slice(fileIndex + 1).filter((child) => !isValidElement(child) || child.type !== "ul")
    const nestedLists = children.slice(fileIndex + 1).filter((child) => isValidElement(child) && child.type === "ul")
    return cloneElement(node, undefined,
      <div className="docs-filesystem-row">
        <FileIcon kind={fileIconKindOf(name)} />
        <div className="docs-filesystem-entry">
          {file}
          {textFrom(description).trim() ? <span className="docs-filesystem-description">{description}</span> : null}
        </div>
      </div>,
      withFileIcons(nestedLists)
    )
  }
  return cloneElement(node, undefined, withFileIcons(node.props.children))
}

export const Filesystem = ({ children, root }: { readonly children: ReactNode; readonly root: string }): ReactElement => (
  <div className="docs-filesystem" aria-label={`${root} filesystem`}>
    <strong>{root}</strong>
    {withFileIcons(children)}
  </div>
)
