import { expect, test } from "bun:test"
import * as fc from "fast-check"
import { LogView } from "../src/runtime/log-view"

// Each step appends a batch to an earlier view, at the tip or not, so views share and branch backing arrays.
const steps = fc.array(fc.record({ from: fc.nat(), batch: fc.array(fc.integer(), { maxLength: 4 }) }), { maxLength: 40 })

// A view reads as the plain array it denotes: the same items through every read method.
const expectReadsAs = (view: LogView<number>, model: number[]) => {
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
}

test("appending to the empty view leaves it owning nothing", () => {
  LogView.empty.append([1, 2, 3] as never[])
  expect(JSON.stringify(LogView.empty)).toBe("[]")
  expect(Bun.inspect(LogView.empty)).not.toContain("1")
})

test("a view never changes and append extends it like array concatenation", () => {
  fc.assert(fc.property(steps, steps => {
    const views: LogView<number>[] = [LogView.empty]
    const models: number[][] = [[]]
    for (const { from, batch } of steps) {
      const index = from % views.length
      views.push(views[index]!.append(batch))
      models.push([...models[index]!, ...batch])
      views.forEach((view, at) => expectReadsAs(view, models[at]!))
    }
  }), { numRuns: 500 })
})
