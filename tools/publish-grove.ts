import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import grove from "../packages/grove/package.json"
import core from "../packages/core/package.json"
import platform from "../packages/platform/package.json"

const directory = fileURLToPath(new URL("../packages/grove", import.meta.url))
const packOnly = process.argv.includes("--pack-only")
const dryRun = process.argv.includes("--dry-run")
for (const consumer of [core, platform]) {
  if (consumer.dependencies["@tardie/grove"] !== grove.version) throw new Error(`${consumer.name} must depend on ${grove.name}@${grove.version}`)
}
const run = async (command: readonly string[], cwd = directory) => {
  const child = Bun.spawn([...command], { cwd, stdout: "inherit", stderr: "inherit" })
  if (await child.exited !== 0) throw new Error(`${command.join(" ")} failed`)
}
const temporary = await mkdtemp(join(tmpdir(), "grove-publish-"))
try {
  await run([process.execPath, "pm", "pack", "--destination", temporary, "--ignore-scripts"])
  const tarball = join(temporary, `tardie-grove-${grove.version}.tgz`)
  if (!packOnly) {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(grove.name)}/${grove.version}`)
    if (response.ok) {
      const published = await response.json() as { readonly dist: { readonly integrity: string } }
      const integrity = `sha512-${createHash("sha512").update(Buffer.from(await Bun.file(tarball).arrayBuffer())).digest("base64")}`
      if (published.dist.integrity !== integrity) throw new Error(`${grove.name}@${grove.version} differs from npm; bump Grove and its consumer dependency versions`)
      console.log(`${grove.name}@${grove.version} already published with matching contents`)
    } else if (response.status === 404) {
      await run(["npm", "publish", tarball, "--access", "public", ...(dryRun ? ["--dry-run"] : [])])
    } else throw new Error(`Grove registry lookup failed: ${response.status}`)
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
