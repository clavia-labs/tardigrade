import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { childKeyOf, childThreadId, threadIdOf, type ChildKey, type ThreadId } from "./index"

const parent = { actor: "researcher", instance: "main", thread: "root" }
const opaqueString = fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 1, maxLength: 80 })
  .map((units) => String.fromCharCode(...units))
const coordinates = fc.record({
  parent: fc.record({
    actor: opaqueString,
    instance: opaqueString.map((value) => value.replaceAll(":", "_")),
    thread: opaqueString
  }),
  child: opaqueString.map((value) => childKeyOf(value))
})

// Safety properties await derivation; the test runner's timeout also checks completion on sampled inputs.
describe("child identity safety", () => {
  test("replay stability: identical coordinates retain their identity", async () => {
    await fc.assert(fc.asyncProperty(coordinates, async ({ parent, child }) => {
      const id = await childThreadId({ parent, child })
      expect(await childThreadId({ parent: { ...parent }, child })).toBe(id)
    }))
  })

  test("replay stability: the persisted encoding matches a fixed digest", async () => {
    const id = await childThreadId({ parent, child: childKeyOf("step") })
    expect(String(id)).toBe("ddc9895cb08a2f469846924b97c3b997dfb82ed5f6d1ff9c04174d89af7dcb27")
  })

  test("scope separation: every coordinate and tuple boundary contributes", async () => {
    await fc.assert(fc.asyncProperty(coordinates, async ({ parent, child }) => {
      const ids = await Promise.all([
        childThreadId({ parent, child }),
        childThreadId({ parent: { ...parent, actor: parent.actor + "x" }, child }),
        childThreadId({ parent: { ...parent, instance: parent.instance + "x" }, child }),
        childThreadId({ parent: { ...parent, thread: parent.thread + "x" }, child }),
        childThreadId({ parent, child: childKeyOf(child + "x") })
      ])
      expect(new Set(ids).size).toBe(ids.length)
    }))
    const pairs = [["a", "b:c"], ["a:b", "c"], ["a", "\ud800"], ["a", "\ufffd"]] as const
    const ids = await Promise.all(pairs.map(([thread, child]) => childThreadId({
      parent: { ...parent, thread }, child: childKeyOf(child)
    })))
    expect(new Set(ids).size).toBe(pairs.length)
  })

  test("root separation: distinct roots have disjoint descendants at every equal depth", async () => {
    await fc.assert(fc.asyncProperty(
      coordinates,
      fc.constantFrom("actor", "instance", "thread"),
      fc.array(fc.uniqueArray(opaqueString, { minLength: 1, maxLength: 3 }), { minLength: 2, maxLength: 4 }),
      async ({ parent }, coordinate, levels) => {
        const otherRoot = { ...parent, [coordinate]: parent[coordinate] + "x" }
        let left = [parent]
        let right = [otherRoot]
        for (const keys of levels) {
          const descend = (parents: typeof left) => Promise.all(parents.flatMap((address) =>
            keys.map(async (key) => ({
              ...address,
              thread: await childThreadId({ parent: address, child: childKeyOf(key) })
            }))
          ))
          const next = await Promise.all([descend(left), descend(right)])
          left = next[0]
          right = next[1]
          const leftIds = new Set(left.map((address) => address.thread))
          const rightIds = new Set(right.map((address) => address.thread))
          expect(leftIds.size).toBe(left.length)
          expect(rightIds.size).toBe(right.length)
          for (const id of rightIds) expect(leftIds.has(id)).toBe(false)
        }
      }
    ))
  })

  test("valid bounded output: derivations resolve and invalid coordinates reject", async () => {
    await fc.assert(fc.asyncProperty(coordinates, async (input) => {
      expect(await childThreadId(input)).toMatch(/^[0-9a-f]{64}$/)
    }))
    let thread = "root".repeat(10_000)
    for (let depth = 0; depth < 20; depth++) {
      thread = await childThreadId({ parent: { ...parent, thread }, child: childKeyOf("step".repeat(10_000)) })
      expect(thread).toMatch(/^[0-9a-f]{64}$/)
    }
    for (const invalid of ["", null, 1]) {
      expect(() => childKeyOf(invalid)).toThrow()
      expect(() => threadIdOf(invalid)).toThrow()
    }
    const child = childKeyOf("step")
    for (const invalidParent of [
      { ...parent, actor: "" },
      { ...parent, instance: "" },
      { ...parent, instance: "a:b" },
      { ...parent, thread: "" }
    ]) {
      await expect(childThreadId({ parent: invalidParent, child })).rejects.toThrow()
    }
    await expect(childThreadId({ parent, child: "" as ChildKey })).rejects.toThrow()
  })
})

test("type safety: thread identifiers cannot substitute for child keys", () => {
  const thread: ThreadId = threadIdOf("root")
  // @ts-expect-error ThreadId cannot identify a parent-scoped child.
  const child: ChildKey = thread
  expect(String(child)).toBe("root")
})
