import { strict as assert } from "node:assert"
import { test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { decodeCheckpoint } from "@clavia/tardigrade-core"
import { bunJournal } from "../../src/bun"
import { bunThreadPath } from "../../src/bun/observe"
import { checkpointE2E } from "../properties/checkpoint/e2e"
import { atomPopulationKinds } from "../fixtures/atoms/population"
import { CHECKPOINT_E2E_ACTOR, checkpointE2EInstance } from "../fixtures/atoms/checkpoint-actor"
import { testStage } from "../fixtures/wait"
import { RUNTIME_PROPERTY_TEST_TIMEOUT_MS } from "../properties/runtime/config"

for (const kind of atomPopulationKinds) test(`checkpoint E2E survives process death (${kind})`, async () => {
  const storage = mkdtempSync(join(tmpdir(), "tardie-checkpoint-e2e-"))
  const filename = bunThreadPath(storage, { actor: CHECKPOINT_E2E_ACTOR, instance: checkpointE2EInstance(kind), thread: "one" })
  let child: ReturnType<typeof start> | undefined
  async function ready(running: ReturnType<typeof start>) {
    const reader = running.process.stdout.getReader()
    const decoder = new TextDecoder()
    let buffered = ""
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`Checkpoint child exited before readiness: ${await running.errors}`)
        buffered += decoder.decode(chunk.value, { stream: true })
        let newline = buffered.indexOf("\n")
        while (newline !== -1) {
          const line = buffered.slice(0, newline)
          buffered = buffered.slice(newline + 1)
          if (line.startsWith('{"type":"checkpoint-ready"')) return JSON.parse(line) as { readonly url: string; readonly pid: number }
          newline = buffered.indexOf("\n")
        }
      }
    } finally { reader.releaseLock() }
  }
  function start() {
    const childProcess = Bun.spawn([process.execPath, new URL("../fixtures/bun/checkpoint-e2e.ts", import.meta.url).pathname, storage, kind], { stdout: "pipe", stderr: "pipe" })
    return { process: childProcess, errors: new Response(childProcess.stderr).text() }
  }
  let endpoint: { readonly url: string; readonly pid: number }
  const launch = async () => {
    child = start()
    endpoint = await testStage("starting checkpoint child", () => ready(child!), RUNTIME_PROPERTY_TEST_TIMEOUT_MS)
  }
  const kill = async () => {
    if (!child) return
    child.process.kill("SIGKILL")
    await child.process.exited
    await child.errors
    child = undefined
  }
  try {
    await launch()
    await checkpointE2E(kind, {
      fetch: request => fetch(new Request(new URL(new URL(request.url).pathname, endpoint.url).href, request)),
      checkpoint: async () => {
        const journal = bunJournal({ filename, actor: "events" })
        try { const saved = journal.readCheckpoint(); return saved ? decodeCheckpoint(saved.payload) : undefined }
        finally { await Effect.runPromise(journal.close) }
      },
      restart: async () => {
        const previous = endpoint.pid
        await kill()
        await launch()
        assert.notEqual(endpoint.pid, previous)
      },
    })
  } finally { await kill(); rmSync(storage, { recursive: true, force: true }) }
}, RUNTIME_PROPERTY_TEST_TIMEOUT_MS)
