import mdx from "@mdx-js/rollup"
import rehypeHighlight from "rehype-highlight"
import rehypeMdxCodeProps from "rehype-mdx-code-props"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import remarkFrontmatter from "remark-frontmatter"
import remarkMdxFrontmatter from "remark-mdx-frontmatter"

export default defineConfig({
  plugins: [
    {
      enforce: "pre",
      ...mdx({
        providerImportSource: "@mdx-js/react",
        rehypePlugins: [[rehypeHighlight, { detect: false, plainText: ["curl", "text", "txt"] }], rehypeMdxCodeProps],
        remarkPlugins: [remarkFrontmatter, [remarkMdxFrontmatter, { name: "frontmatter" }]]
      })
    },
    react({ include: /\.(?:js|jsx|mdx|ts|tsx)$/ })
  ]
})
