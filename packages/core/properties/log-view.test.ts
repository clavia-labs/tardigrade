import { expect, test } from "bun:test"
import * as fc from "fast-check"
import { IndexView, LogView, RangeLog } from "../src/runtime/log-view"

// Each step appends a batch to an earlier view, at the tip or not, so views share and branch backing arrays.
const steps = fc.array(fc.record({ from: fc.nat(), batch: fc.array(fc.integer(), { maxLength: 4 }) }), { maxLength: 40 })

// A view reads as the plain array it denotes: the same items through every read method.
const expectReadsAs = (view: LogView<number> | RangeLog<number>, model: number[]) => {
  expect(view.toJSON()).toEqual(model)
  expect([...view]).toEqual(model)
  expect(view.length).toBe(model.length)
  for (let index = -model.length - 1; index <= model.length; index++) expect(view.at(index)).toBe(model.at(index))
  for (let start = -model.length - 1; start <= model.length + 1; start++) expect(view.slice(start)).toEqual(model.slice(start))
  expect(view.slice(1, -1)).toEqual(model.slice(1, -1))
  expect(view.findIndex(item => item % 2 === 0)).toBe(model.findIndex(item => item % 2 === 0))
  expect(view.find(item => item % 2 === 0)).toBe(model.find(item => item % 2 === 0))
  expect(view.some(item => item > 2)).toBe(model.some(item => item > 2))
  expect(view.filter(item => item > 0)).toEqual(model.filter(item => item > 0))
  if (view instanceof LogView) expect(view.take(model.length >> 1).slice()).toEqual(model.slice(0, model.length >> 1))
}

test("appending to the empty view leaves it owning nothing", () => {
  LogView.empty.append([1, 2, 3] as never[])
  expect(JSON.stringify(LogView.empty)).toBe("[]")
  expect(Bun.inspect(LogView.empty)).not.toContain("1")
  for (const length of [-1, 1, 0.5, Number.NaN]) expect(() => LogView.empty.take(length)).toThrow()
  for (const batchSize of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => new RangeLog(0, () => [], batchSize)).toThrow()
  const unavailable = new RangeLog(1, () => [], 1)
  for (const read of [() => unavailable.at(0), () => unavailable.slice(), () => [...unavailable]]) expect(read).toThrow("unavailable")
})

test("a view never changes and append extends it like array concatenation", () => {
  fc.assert(fc.property(steps, steps => {
    const views: LogView<number>[] = [LogView.empty]
    const models: number[][] = [[]]
    for (const { from, batch } of steps) {
      const index = from % views.length
      views.push(views[index]!.append(batch))
      models.push([...models[index]!, ...batch])
      views.forEach((view, at) => {
        const model = models[at]!
        expectReadsAs(view, model)
        let reads = 0
        const ranged = new RangeLog(model.length, (from, to) => { reads++; expect(to).toBeLessThanOrEqual(model.length); return model.slice(from, to) }, 2)
        expect(reads).toBe(0)
        expectReadsAs(ranged, model)
        if (model.length) {
          const before = reads
          ranged.at(0)
          ranged.at(0)
          expect(reads - before).toBe(2)
        }
      })
    }
  }), { numRuns: 500 })
})

// Each step sets a key from a small pool, so steps both add and replace, from an earlier view at the tip or not.
const sets = fc.array(fc.record({ from: fc.nat(), key: fc.integer({ min: 0, max: 5 }), value: fc.integer({ min: 0, max: 3 }) }), { maxLength: 40 })

test("an index view never changes and set behaves like Map.set on a copy", () => {
  fc.assert(fc.property(sets, sets => {
    const views: IndexView<number, number>[] = [IndexView.empty()]
    const models: Map<number, number>[] = [new Map()]
    for (const { from, key, value } of sets) {
      const index = from % views.length
      views.push(views[index]!.set(key, value))
      models.push(new Map(models[index]!).set(key, value))
      views.forEach((view, at) => {
        const model = models[at]!
        expect([...view]).toEqual([...model])
        expect(view.size).toBe(model.size)
        for (let probe = 0; probe <= 5; probe++) {
          expect(view.get(probe)).toBe(model.get(probe))
          expect(view.has(probe)).toBe(model.has(probe))
        }
      })
    }
  }), { numRuns: 500 })
})
