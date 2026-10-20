import { performance } from "node:perf_hooks"
import { btree, DEFAULT_CAPACITY, type Metrics } from "./btree"

const option = (name: string, fallback: number) => {
  const input = process.argv.find(argument => argument.startsWith(`--${name}=`))
  const value = input ? Number(input.slice(name.length + 3)) : fallback
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`)
  return value
}
const capacity = option("capacity", DEFAULT_CAPACITY), maximum = option("max", 1_000_000), samples = option("samples", 256)
const tree = btree<number, number>((a, b) => a - b, { capacity })
const order = process.argv.find(argument => argument.startsWith("--order="))?.slice(8) ?? "ascending"
if (!["ascending", "descending", "shuffled"].includes(order)) throw new Error("Invalid order")
const seed = option("seed", 20261020)
let root = tree.empty(), random = seed
const rows: Array<Record<string, number | string>> = []
const peaks = (work: (index: number) => void): Metrics => {
  const peak: Metrics = { visits: 0, comparisons: 0, pages: 0, slots: 0, splits: 0, merges: 0, redistributions: 0 }
  for (let index = 0; index < samples; index++) {
    tree.resetStats(); work(index)
    const value = tree.stats()
    for (const key of Object.keys(peak) as (keyof Metrics)[]) peak[key] = Math.max(peak[key], value[key])
  }
  return peak
}
for (let length = Math.min(1000, maximum); ; length = Math.min(length * 10, maximum)) {
  root = tree.empty()
  const keys = Array.from({ length }, (_, index) => index)
  if (order === "descending") keys.reverse()
  if (order === "shuffled") for (let index = keys.length - 1; index > 0; index--) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0
    const selected = random % (index + 1)
    const held = keys[index]!; keys[index] = keys[selected]!; keys[selected] = held
  }
  const started = performance.now()
  for (const key of keys) root = tree.set(root, 2 * key, key)
  const buildMs = Math.round(performance.now() - started)
  const key = (index: number) => 2 * ((index * 2654435761) % length)
  const lookup = peaks(index => { const selected = key(index); if (tree.get(root, selected) !== selected / 2) throw new Error("Incorrect point lookup") })
  const update = peaks(index => { tree.set(root, key(index), -index - 1) })
  const insert = peaks(index => { tree.set(root, key(index) + 1, index) })
  const remove = peaks(index => { tree.delete(root, key(index)) })
  const range = peaks(index => {
    const start = key(index), iterator = tree.scan(root, { from: start, to: start + 198 })
    let count = 0
    while (!iterator.next().done) count++
    if (count !== Math.min(100, length - start / 2)) throw new Error("Incorrect range output")
  })
  let idealVisits = 1, filled = capacity
  while (filled < length) { idealVisits++; filled *= capacity }
  rows.push({ idealVisits, entries: length, height: root.height, lookupVisits: lookup.visits, lookupComparisons: lookup.comparisons, updatePages: update.pages, updateSlots: update.slots, insertPages: insert.pages, deleteVisits: remove.visits, deletePages: remove.pages, deleteSlots: remove.slots, range100Visits: range.visits, buildMs })
  if (length === maximum) break
}
console.log(JSON.stringify({ capacity, samples, order, seed, rows }, null, 2))
