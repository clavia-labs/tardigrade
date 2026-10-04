import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { threadFlow } from "./fixtures/thread-flow"

const args = process.argv.slice(2)
const dryRun = args.length === 1 && args[0] === "--dry-run"
const existing = args.length === 2 && args[0] === "--url" ? new URL(args[1]!) : undefined
if (args.length && !dryRun && !existing) throw new Error("Usage: bun run test:deployed [--dry-run | --url URL]")
if (existing && !["http:", "https:"].includes(existing.protocol)) throw new Error("Test URLs require HTTP or HTTPS")

const flow = (url: string, token?: string) => threadFlow(request => fetch(request), crypto.randomUUID(), {
  url, ...(token ? { token } : {}), policy: { timeoutMs: 30_000, pollIntervalMs: 100 },
}).run()

if (existing) {
  await flow(existing.origin, process.env.FIXTURE_TOKEN)
} else {
  const name = `tdg-layout-test-${crypto.randomUUID()}`
  const directory = await mkdtemp(join(tmpdir(), "tdg-deployed-test-"))
  const config = join(directory, "wrangler.json")
  const secrets = join(directory, "secrets.json")
  const token = crypto.randomUUID()
  const manifest = {
    name, main: fileURLToPath(new URL("./workerd/layout-fixture.ts", import.meta.url)),
    compatibility_date: "2026-08-08", compatibility_flags: ["nodejs_compat"], workers_dev: true,
    durable_objects: { bindings: [{ name: "ACTORS", class_name: "LayoutActorDO" }, { name: "THREADS", class_name: "LayoutThreadDO" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["LayoutActorDO", "LayoutThreadDO"] }],
  }
  await Bun.write(config, JSON.stringify(manifest))
  await Bun.write(secrets, JSON.stringify({ FIXTURE_TOKEN: token }))
  const wrangler = async (...command: string[]) => {
    const child = Bun.spawn(["bun", "x", "--no-install", "wrangler", ...command, "--config", config], {
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" }, stdin: "ignore", stdout: "pipe", stderr: "inherit",
    })
    const output = await new Response(child.stdout).text()
    console.log(output)
    if (await child.exited) throw new Error(`Wrangler ${command[0]} failed for ${name}`)
    return output
  }
  let deployed = false
  try {
    const output = await wrangler("deploy", "--secrets-file", secrets, ...(dryRun ? ["--dry-run"] : []))
    if (!dryRun) {
      deployed = true
      const url = output.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0]
      if (!url) throw new Error("Wrangler did not return a workers.dev URL")
      await flow(url, token)
    }
  } finally {
    try {
      if (deployed) {
        const retired = join(directory, "retired.js")
        await Bun.write(retired, 'export default { fetch: () => new Response("Fixture retired", { status: 410 }) }')
        await Bun.write(config, JSON.stringify({
          ...manifest, main: retired, durable_objects: { bindings: [] },
          migrations: [...manifest.migrations, { tag: "v2", deleted_classes: manifest.migrations[0]!.new_sqlite_classes }],
        }))
        try { await wrangler("deploy") }
        finally { await wrangler("delete", name, "--force") }
      }
    }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}
console.log(dryRun ? "Fixture Worker bundle passed" : "Deployed thread flow passed")
