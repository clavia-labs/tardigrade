import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import type { FileSystem } from "effect/FileSystem"
import type { Path } from "effect/Path"
import { BunFileSystem, BunPath } from "@effect/platform-bun"

import { DEFAULT_FILES_SKIP, defaultFilesRoot, filesPackage, filesPolicyOf } from "./files"

// The files package against a real directory this file owns. The platform layers are the ones a
// host binds, so what compiles here compiles where the package is mounted (apps/server/src/host.ts).

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer)

let root = ""

// A method may fail with `Park`, so the helper carries the failure rather than asserting it away:
// runPromise rejects, and a test that parks says so instead of reading a narrowed type.
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem | Path>) =>
  Effect.runPromise(Effect.provide(effect, platform))

const call = (method: string, args: unknown) => {
  const pkg = filesPackage({ policy: { root } })
  return run(pkg.methods[method]!(args, { callId: "c1" }))
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tdg-files-"))
  await writeFile(join(root, "notes.txt"), "alpha\nbeta\ngamma\n")
  await mkdir(join(root, "src"))
  await writeFile(join(root, "src", "one.ts"), "export const one = 1 // beta\n")
  await mkdir(join(root, "node_modules"))
  await writeFile(join(root, "node_modules", "loud.txt"), "beta beta beta\n")
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("the files policy", () => {
  test("the root defaults to the working directory and every bound is overridable", () => {
    expect(filesPolicyOf().root).toBe(defaultFilesRoot())
    expect(filesPolicyOf({ root: "/tmp", readChars: 8, maxMatches: 1 })).toEqual({
      root: "/tmp",
      readChars: 8,
      maxEntries: 500,
      maxMatches: 1,
      skip: DEFAULT_FILES_SKIP
    })
  })
})

describe("the files package", () => {
  // The confinement is the whole of what the root means: a path that resolves outside it is an
  // answer the model reads and can act on, never a throw that kills the attempt.
  test("a path outside the root is refused, and says so", async () => {
    for (const path of ["../escape.txt", "../../etc/passwd", "/etc/passwd"]) {
      const answer = (await call("read", { path })) as { error?: string; text?: string }
      expect(answer.text).toBeUndefined()
      expect(answer.error).toContain("outside the root")
    }
    const written = (await call("write", { path: "../escape.txt", text: "no" })) as { error?: string }
    expect(written.error).toContain("outside the root")
    const listed = (await call("list", { path: ".." })) as { error?: string }
    expect(listed.error).toContain("outside the root")
  })

  test("a file inside the root reads whole, with its size", async () => {
    const answer = (await call("read", { path: "notes.txt" })) as { text: string; size: number; truncated?: boolean }
    expect(answer.text).toBe("alpha\nbeta\ngamma\n")
    expect(answer.size).toBe(17)
    expect(answer.truncated).toBeUndefined()
  })

  test("a slice past the cap says truncated", async () => {
    const pkg = filesPackage({ policy: { root, readChars: 5 } })
    const answer = (await run(
      pkg.methods["read"]!({ path: "notes.txt", length: 1000 }, { callId: "c1" })
    )) as { text: string; size: number; truncated?: boolean }
    expect(answer.text).toBe("alpha")
    expect(answer.size).toBe(17)
    expect(answer.truncated).toBe(true)
  })

  test("a write lands inside the root and reads back", async () => {
    const written = (await call("write", { path: "out/made.txt", text: "hello" })) as { path: string; size: number }
    expect(written).toEqual({ path: join("out", "made.txt"), size: 5 })
    const answer = (await call("read", { path: "out/made.txt" })) as { text: string }
    expect(answer.text).toBe("hello")
  })

  test("a listing names what is there, by type", async () => {
    const answer = (await call("list", {})) as { entries: ReadonlyArray<{ name: string; type: string }> }
    const byName = new Map(answer.entries.map((entry) => [entry.name, entry.type]))
    expect(byName.get("notes.txt")).toBe("File")
    expect(byName.get("src")).toBe("Directory")
  })

  // The walk never enters what the policy skips, so a repository's installed packages cannot fill
  // a turn's context with matches nobody asked for (files.ts, DEFAULT_FILES_SKIP).
  test("search finds text under the root and skips what the policy skips", async () => {
    const answer = (await call("search", { pattern: "beta" })) as {
      matches: ReadonlyArray<{ path: string; line: number; text: string }>
      truncated?: boolean
    }
    const paths = answer.matches.map((match) => match.path)
    expect(paths).toContain("notes.txt")
    expect(paths).toContain(join("src", "one.ts"))
    expect(paths.some((path) => path.includes("node_modules"))).toBe(false)
    expect(answer.matches.find((match) => match.path === "notes.txt")).toEqual({
      path: "notes.txt",
      line: 2,
      text: "beta"
    })
  })

  test("a match-heavy search stops at the cap and says truncated", async () => {
    const pkg = filesPackage({ policy: { root, maxMatches: 1 } })
    const answer = (await run(
      pkg.methods["search"]!({ pattern: "beta" }, { callId: "c1" })
    )) as { matches: ReadonlyArray<unknown>; truncated?: boolean }
    expect(answer.matches.length).toBe(1)
    expect(answer.truncated).toBe(true)
  })

  test("a file that is not there is an error the model reads", async () => {
    const answer = (await call("read", { path: "nothing.txt" })) as { error?: string }
    expect(answer.error).toBeDefined()
  })

  test("every method states its annotations, and only write is a write", () => {
    const pkg = filesPackage({ policy: { root } })
    expect(pkg.annotations?.["read"]?.readOnlyHint).toBe(true)
    expect(pkg.annotations?.["list"]?.readOnlyHint).toBe(true)
    expect(pkg.annotations?.["search"]?.readOnlyHint).toBe(true)
    expect(pkg.annotations?.["write"]?.readOnlyHint).toBe(false)
    expect(pkg.annotations?.["write"]?.destructiveHint).toBe(true)
    for (const method of Object.keys(pkg.methods)) expect(pkg.annotations?.[method]?.openWorldHint).toBe(false)
  })
})
