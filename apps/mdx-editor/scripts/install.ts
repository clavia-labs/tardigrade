import { copyFile, mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const plugin = fileURLToPath(new URL("../../../docs/.obsidian/plugins/mdx-editor/", import.meta.url))
const packageRoot = fileURLToPath(new URL("../", import.meta.url))

await mkdir(plugin, { recursive: true })
await Promise.all([
  copyFile(`${packageRoot}dist/main.js`, `${plugin}main.js`),
  copyFile(`${packageRoot}dist/styles.css`, `${plugin}styles.css`),
  copyFile(`${packageRoot}manifest.json`, `${plugin}manifest.json`)
])

console.log(`Installed mdx-editor in ${plugin}`)
