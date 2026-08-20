import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

// What `tdg --version` answers. The number is read off the manifest the command was installed from
// rather than written down here, because a copy of a version is a copy that rots
// (version.test.ts).
//
// Two layouts hold that manifest, the same two the UI arrives in (assets.ts). Installed, the
// command sits at `src/cli/` under the package root. In this repository, it sits at
// `apps/cli/src/`, and the version that matters is the workspace root's, since that is the one the
// publish tool stamps on the package (tools/publish.ts).

export const INSTALLED_MANIFEST = "../../package.json"

export const REPO_MANIFEST = "../../../package.json"

export const MANIFEST_CANDIDATES: ReadonlyArray<string> = [INSTALLED_MANIFEST, REPO_MANIFEST]

// What is reported when no manifest can be read, which is a command running from somewhere neither
// layout describes.
export const UNKNOWN_VERSION = "0.0.0-unknown"

const versionOf = async (path: string): Promise<string | undefined> => {
  const raw: unknown = await readFile(path, "utf8").then(JSON.parse).catch(() => undefined)
  if (typeof raw !== "object" || raw === null) return undefined
  const version = (raw as { version?: unknown }).version
  return typeof version === "string" ? version : undefined
}

// versionIn reads the first manifest that answers, relative to the module that asks.
export const versionIn = async (from: string): Promise<string> => {
  for (const candidate of MANIFEST_CANDIDATES) {
    const found = await versionOf(fileURLToPath(new URL(candidate, from)))
    if (found !== undefined) return found
  }
  return UNKNOWN_VERSION
}
