import { describe, expect, test } from "bun:test"
import { sha256 } from "./sha256"

// The digest is hand written, so it is checked against the published vectors. A wrong hash would
// give every harness a plausible id that no other implementation agrees with.
describe("sha256", () => {
  test("matches the published vectors", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(sha256("hello world")).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
    )
  })

  test("crosses the block boundary correctly", () => {
    // 55, 56, and 64 bytes are the lengths where the padding needs a second block.
    expect(sha256("a".repeat(55))).toBe(
      "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"
    )
    expect(sha256("a".repeat(56))).toBe(
      "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"
    )
    expect(sha256("a".repeat(64))).toBe(
      "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"
    )
  })

  test("reads unicode as utf-8", () => {
    expect(sha256("é")).toBe("4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c")
  })
})
