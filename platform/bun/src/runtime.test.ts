import { expect, setDefaultTimeout, test } from "bun:test"

// This case waits out a ten second response on purpose: the deadline it proves is the one that
// keeps a slow answer from being cut off, so the wall clock is the assertion. The budget is that
// floor plus room for a parallel gate run, and no more, so a hang still fails rather than waits.
const DEADLINE_MS = 25_000

setDefaultTimeout(DEADLINE_MS)

test("a numeric fetch deadline extends Bun's socket idle deadline", async () => {
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: async () => {
      await Bun.sleep(10_000)
      return new Response("ok")
    }
  })

  try {
    const script = `const response = await fetch(${JSON.stringify(server.url.toString())}, { timeout: 20000 }); process.stdout.write(await response.text())`
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1" },
      stdout: "pipe",
      stderr: "pipe"
    })
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])

    expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "ok", stderr: "" })
  } finally {
    server.stop(true)
  }
})
