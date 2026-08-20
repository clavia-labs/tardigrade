import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

import {
  ASSET_CANDIDATES,
  AssetsMissing,
  assetsIn,
  BUILD_COMMAND,
  INDEX_FILE,
  INSTALLED_ASSETS,
  REPO_ASSETS,
  resolveAssets
} from "./assets"

// Where the UI comes from. The rule is first match wins, and no match is a failure that names the
// command to run, because a process that listened without a UI would report the miss as a blank
// page.

const built = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "tardigrade-assets-"))
  writeFileSync(join(directory, INDEX_FILE), "<!doctype html>")
  return directory
}

describe("assetsIn", () => {
  test("the first directory holding an index wins", () => {
    const first = built()
    const second = built()
    expect(assetsIn([join(tmpdir(), "tardigrade-absent"), first, second])).toBe(first)
  })

  test("a directory without an index is not a build", () => {
    const empty = mkdtempSync(join(tmpdir(), "tardigrade-empty-"))
    expect(() => assetsIn([empty])).toThrow(AssetsMissing)
  })

  test("the failure names the command that makes a build", () => {
    try {
      assetsIn([join(tmpdir(), "tardigrade-absent")])
      expect.unreachable()
    } catch (failure) {
      expect(failure).toBeInstanceOf(AssetsMissing)
      expect((failure as AssetsMissing).message).toContain(BUILD_COMMAND)
      expect((failure as AssetsMissing).looked).toHaveLength(1)
    }
  })
})

describe("resolveAssets", () => {
  test("a stated directory is taken as stated", () => {
    const directory = built()
    expect(resolveAssets(directory)).toBe(directory)
  })

  test("a stated directory is still checked", () => {
    expect(() => resolveAssets(join(tmpdir(), "tardigrade-absent"))).toThrow(AssetsMissing)
  })

  // Two layouts, tried in order: the build staged in a published package, then the build vite
  // writes inside this repository. Neither can be a prefix of the other, or a repository checkout
  // would serve the voyager's source index in place of its build.
  test("the candidates are the two layouts a build arrives in", () => {
    expect(ASSET_CANDIDATES).toEqual([INSTALLED_ASSETS, REPO_ASSETS])
    expect(REPO_ASSETS.startsWith(INSTALLED_ASSETS)).toBe(false)
    expect(INSTALLED_ASSETS.startsWith(REPO_ASSETS)).toBe(false)
  })
})
