import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const run = async (mode: "seed" | "restore", directory: string): Promise<string> => {
  const child = Bun.spawn([process.execPath, new URL("./backup-process.ts", import.meta.url).pathname, mode, directory], {
    stdout: "pipe", stderr: "pipe"
  })
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`backup ${mode} failed: ${errors}`)
  return output.trim()
}

test("Bun host recovers a published checkpoint in another process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tardigrade-backup-e2e-"))
  try {
    const checkpoint = await run("seed", directory)
    expect(checkpoint).not.toBe("")
    await rm(join(directory, "local"), { recursive: true, force: true })
    expect(await run("restore", directory)).toBe(checkpoint)

    const instance = Buffer.from(JSON.stringify(["backup-e2e", "one"])).toString("base64url")
    const thread = Buffer.from("main").toString("base64url")
    const database = new Database(join(directory, "local", `${instance}.sqlite.threads`, `${thread}.sqlite`), { readonly: true })
    try {
      const events = database.query<{ event: string }, []>("SELECT event FROM events ORDER BY seq").all().map((row) => JSON.parse(row.event) as { type: string })
      expect(events.some((event) => event.type === "ThreadCreated")).toBe(true)
    } finally { database.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
