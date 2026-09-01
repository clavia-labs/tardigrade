import mdx from "@mdx-js/rollup"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import { readFile } from "node:fs/promises"
import { nitro } from "nitro/vite"
import rehypeHighlight from "rehype-highlight"
import rehypeMdxCodeProps from "rehype-mdx-code-props"
import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import remarkFrontmatter from "remark-frontmatter"
import remarkMdxFrontmatter from "remark-mdx-frontmatter"

const MDX_SOURCE_QUERY = "?mdx-source"
const MDX_SOURCE_PREFIX = "\0mdx-source:"
const MDX_SOURCE_SUFFIX = ":source"

const mdxSource = (): Plugin => ({
  name: "mdx-source",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (!source.endsWith(MDX_SOURCE_QUERY)) return undefined
    const resolved = await this.resolve(source.slice(0, -MDX_SOURCE_QUERY.length), importer, { ...options, skipSelf: true })
    if (resolved === null) return undefined
    return `${MDX_SOURCE_PREFIX}${resolved.id}${MDX_SOURCE_SUFFIX}`
  },
  async load(id) {
    if (!id.startsWith(MDX_SOURCE_PREFIX) || !id.endsWith(MDX_SOURCE_SUFFIX)) return undefined
    const path = id.slice(MDX_SOURCE_PREFIX.length, -MDX_SOURCE_SUFFIX.length)
    return `export default ${JSON.stringify(await readFile(path, "utf8"))}`
  }
})

export default defineConfig({
  plugins: [
    mdxSource(),
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
        crawlLinks: true,
        filter: ({ path }) => path !== "/console"
      },
      pages: [{ path: "/docs" }]
    }),
    nitro(),
    react({ include: /\.(?:js|jsx|mdx|ts|tsx)$/ })
  ]
})
