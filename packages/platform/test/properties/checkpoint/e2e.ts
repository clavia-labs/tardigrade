import { strict as assert } from "node:assert"
import { atomCheckpointKey, type EffectCheckpoint, type Recorded } from "@clavia/tardigrade-core"
import { atomPopulation, type Changed, type AtomPopulationKind } from "../../fixtures/atoms/population"
import { checkpointE2EInstance, type CheckpointDiagnostics } from "../../fixtures/atoms/checkpoint-actor"
import { methodClient } from "../../fixtures/method-client"

export interface CheckpointE2EHost {
  readonly fetch: (request: Request) => Promise<Response>
  readonly checkpoint: () => Promise<EffectCheckpoint | undefined>
  readonly restart: () => Promise<void>
}

// checkpointE2E checks unequal saved cursors, suffix-only recovery, and continued public calls after physical host replacement.
export async function checkpointE2E(kind: AtomPopulationKind, host: CheckpointE2EHost) {
  const { members, expected } = atomPopulation(kind, "checkpoint.e2e")
  const records: Recorded<Changed>[] = []
  const client = methodClient(host.fetch, checkpointE2EInstance(kind), { url: "https://checkpoint.test" })
  const { request } = client
  let requestId = 0
  const call = (method: string, input: unknown) => client.call("one", method, input, String(requestId++))
  const change = async (id: string, amount: number) => {
    assert.equal(await call("change", { id, amount }), null)
    records.push({ event: { type: "Changed", id, amount } })
  }
  const readAll = async () => {
    for (const member of members) assert.equal(await call("read", member.key), expected(member.key, records))
  }
  const created = await request("", { name: "one" })
  assert.equal(created.status, 200, await created.text())
  for (const [index, member] of members.entries()) await change(member.key, [1, 7, 9][index]!)
  await readAll()
  await change("rick", 3)
  assert.equal(await call("read", "rick"), expected("rick", records))
  const before = await call("diagnostics", null) as CheckpointDiagnostics
  const saved = (await host.checkpoint())!
  assert.ok(saved)
  const entries = members.map(member => saved.durable.find(entry => atomCheckpointKey(entry) === atomCheckpointKey(member.identity))!)
  assert.ok(entries.every(Boolean))
  assert.ok(new Set(entries.map(entry => entry.position)).size > 1, JSON.stringify({ actorPosition: saved.position, entries }))
  for (const [index, member] of members.entries()) assert.equal(entries[index]!.state, expected(member.key, records))
  await change("rick", 4)
  const tail = (await host.checkpoint())!
  assert.ok(tail)
  assert.ok(tail.position > saved.position)
  for (const [index, member] of members.entries()) {
    const retained = tail.durable.find(entry => atomCheckpointKey(entry) === atomCheckpointKey(member.identity))!
    assert.deepEqual(retained, entries[index])
    assert.ok(retained.position < tail.position)
  }
  await host.restart()
  await readAll()
  const recovered = await call("diagnostics", null) as CheckpointDiagnostics
  assert.notEqual(recovered.instance, before.instance)
  assert.deepEqual(recovered.reductions, { rick: 1, morty: 0, summer: 0 })
  await change("rick", 2)
  await readAll()
}
