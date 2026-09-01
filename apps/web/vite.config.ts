import mdx from "@mdx-js/rollup"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { nitro } from "nitro/vite"
import rehypeHighlight from "rehype-highlight"
import rehypeMdxCodeProps from "rehype-mdx-code-props"
import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import remarkFrontmatter from "remark-frontmatter"
import remarkMdxFrontmatter from "remark-mdx-frontmatter"

const DOC_SOURCE_QUERY = "?doc-source"
const DOC_SOURCE_PREFIX = "\0doc-source:"

const docSource = (): Plugin => ({
  name: "doc-source",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (!source.endsWith(DOC_SOURCE_QUERY)) return undefined
    const resolved = await this.resolve(source.slice(0, -DOC_SOURCE_QUERY.length), importer, { ...options, skipSelf: true })
    return resolved === null ? undefined : `${DOC_SOURCE_PREFIX}${resolved.id}.ts`
  },
  async load(id) {
    if (!id.startsWith(DOC_SOURCE_PREFIX) || !id.endsWith(".ts")) return undefined
    return `export default ${JSON.stringify(await readFile(id.slice(DOC_SOURCE_PREFIX.length, -3), "utf8"))}`
  }
})

export default defineConfig({
  resolve: { alias: { "@docs": fileURLToPath(new URL("../../docs/site", import.meta.url)) } },
  plugins: [
    docSource(),
    {
      enforce: "pre",
      ...mdx({
        providerImportSource: "@mdx-js/react",
        rehypePlugins: [[rehypeHighlight, { detect: false, plainText: ["curl", "text", "txt"] }], rehypeMdxCodeProps],
        remarkPlugins: [remarkFrontmatter, [remarkMdxFrontmatter, { name: "frontmatter" }]]
      })
    },
    tanstackStart({
      prerender: {
        enabled: true,
        filter: ({ path }) => path !== "/console" && !path.startsWith("/docs")
      }
    }),
    nitro(),
    react({ include: /\.(?:js|jsx|mdx|ts|tsx)$/ })
  ]
})
