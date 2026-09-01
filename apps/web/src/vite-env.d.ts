/// <reference types="vite/client" />

declare module "*.mdx" {
  import type { ComponentType } from "react"

  export const frontmatter: unknown
  const Content: ComponentType
  export default Content
}

declare module "*.mdx?doc-source" {
  const source: string
  export default source
}
