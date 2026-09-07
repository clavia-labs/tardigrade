import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bunInstances } from "./instances"

test("concurrent opens share a runtime and recovery can resolve that runtime", async () => {
  let opens = 0, recovered = false, closes = 0
  const runtime = { close: async () => { closes++ } }
  const pool = bunInstances<typeof runtime>({
    open: async () => { opens++; return runtime },
    recover: async () => { expect(await pool.open("rick")).toBe(runtime); recovered = true }
  })
  expect(await Promise.all([pool.open("rick"), pool.open("rick")])).toEqual([runtime, runtime])
  await Promise.all([pool.close(), pool.close()])
  expect({ opens, recovered, closes }).toEqual({ opens: 1, recovered: true, closes: 1 })
  expect(() => pool.open("morty")).toThrow("closed")
})

test("failed opens can be retried", async () => {
  let attempts = 0
  const pool = bunInstances({ open: async () => {
    if (++attempts === 1) throw new Error("open failed")
    return { close: async () => {} }
  } })
  await expect(pool.open("rick")).rejects.toThrow("open failed")
  await pool.open("rick")
  expect(attempts).toBe(2)
  await pool.close()
})

test("shutdown aborts and waits for an opening runtime before closing it", async () => {
  let finish!: () => void, closed = false
  const ready = new Promise<void>((resolve) => { finish = resolve })
  const pool = bunInstances({ open: async (_id, signal) => {
    finish()
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    return { close: async () => { closed = true } }
  } })
  const opening = pool.open("rick")
  await ready
  await pool.close()
  await opening
  expect(closed).toBe(true)
})

test("failed restoration closes earlier instances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tardie-instances-"))
  let opened = 0, closed = 0
  const pool = bunInstances({ open: async () => {
    if (++opened === 2) throw new Error("restore failed")
    return { close: async () => { closed++ } }
  } })
  try {
    await Promise.all([writeFile(join(directory, "rick.sqlite"), ""), writeFile(join(directory, "morty.sqlite"), "")])
    await expect(pool.restore(directory, (file) => file)).rejects.toThrow("restore failed")
    expect(closed).toBe(1)
  } finally { await pool.close(); await rm(directory, { recursive: true, force: true }) }
})

test("one failed close does not skip the remaining instances", async () => {
  const closed: string[] = []
  const pool = bunInstances({ open: async (id) => ({ close: async () => {
    closed.push(id)
    if (id === "rick") throw new Error("close failed")
  } }) })
  await Promise.all([pool.open("rick"), pool.open("morty")])
  await expect(pool.close()).rejects.toThrow("instance shutdown failed")
  expect(closed.sort()).toEqual(["morty", "rick"])
})
