import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { formatThreadCoordinate, parseThreadCoordinate } from "./coordinate"

describe("readable thread coordinates", () => {
  test("format and parse actor/instance/thread", () => {
    const coordinate = { actor: "tardie", instance: "rick", thread: "main" }
    expect(formatThreadCoordinate(coordinate)).toBe("tardie/rick/main")
    expect(parseThreadCoordinate("tardie/rick/main")).toEqual(coordinate)
  })

  test("reject missing, empty, and extra segments", () => {
    for (const text of ["", "tardie", "tardie/rick", "/rick/main", "tardie//main", "tardie/rick/", "/tardie/rick/main", "tardie/rick/main/", "tardie/rick/main/child"]) {
      expect(() => parseThreadCoordinate(text)).toThrow()
    }
  })

  test("reject ambiguous and empty fields before formatting", () => {
    for (const field of ["actor", "instance", "thread"] as const) {
      for (const value of ["", "a/b", "/"]) {
        expect(() => formatThreadCoordinate({ actor: "tardie", instance: "rick", thread: "main", [field]: value })).toThrow()
      }
    }
  })

  test("reject non-string input and coordinate fields at runtime", () => {
    for (const value of [null, undefined, 42, {}, []]) {
      expect(() => parseThreadCoordinate(value as unknown as string)).toThrow()
      for (const field of ["actor", "instance", "thread"] as const) {
        expect(() => formatThreadCoordinate({ actor: "tardie", instance: "rick", thread: "main", [field]: value } as unknown as Parameters<typeof formatThreadCoordinate>[0])).toThrow()
      }
    }
  })

  test("preserve opaque names without normalization or URL decoding", () => {
    const coordinate = { actor: "Tardie", instance: " rick ", thread: "研究%2Fmain?#" }
    expect(parseThreadCoordinate(formatThreadCoordinate(coordinate))).toEqual(coordinate)
    expect(formatThreadCoordinate(coordinate)).toBe("Tardie/ rick /研究%2Fmain?#")
  })

  test("round-trip every representable coordinate and distinguish its fields", () => {
    const segment = fc.string({ minLength: 1 }).filter((value) => !value.includes("/"))
    fc.assert(fc.property(fc.record({ actor: segment, instance: segment, thread: segment }), (coordinate) => {
      const text = formatThreadCoordinate(coordinate)
      expect(parseThreadCoordinate(text)).toEqual(coordinate)
      expect(formatThreadCoordinate(parseThreadCoordinate(text))).toBe(text)
      const neighbours = (["actor", "instance", "thread"] as const).map((field) =>
        formatThreadCoordinate({ ...coordinate, [field]: `${coordinate[field]}x` }))
      expect(new Set([text, ...neighbours]).size).toBe(4)
    }))
  })
})
