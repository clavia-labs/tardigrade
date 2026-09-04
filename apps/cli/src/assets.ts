import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

// Where the UI `tdg dev` serves comes from. The voyager is a static build: `vite build` writes a
// directory whose entry is one HTML file, and serving it needs no bundler and no second process, so
// the command reads it off the disk it was installed from (assets.test.ts).
//
// Two layouts hold that directory, and the command tries them in order. Installed, the build is
// staged beside the sources at publish time (tools/publish.ts, STAGED_ASSETS) under a name the
// repository has no directory for, so the two candidates can never match the same place. In this
// repository, the build is where vite wrote it, which is apps/voyager/dist, and the source beside
// it holds an index of its own that vite serves rather than a build. Nothing is fetched and nothing
// is proxied: hot reload stays the voyager's own dev script (docs/references/cli.mdx).

// The file whose presence proves a directory is a build rather than an empty folder.
export const INDEX_FILE = "index.html"

// Where the published package stages the build, relative to this module.
export const INSTALLED_ASSETS = "../../ui/"

// Where vite writes the build inside this repository, relative to this module.
export const REPO_ASSETS = "../../voyager/dist/"

// What to run when neither layout holds a build.
export const BUILD_COMMAND = "bun run --cwd apps/voyager build"

export const ASSET_CANDIDATES: ReadonlyArray<string> = [INSTALLED_ASSETS, REPO_ASSETS]

// AssetsMissing names every place that was looked in, so an operator can see which layout was
// expected rather than guess. It is thrown before the server starts listening: a UI-less process
// answering the API at a URL that serves nothing at `/` is the confusing state this avoids.
export class AssetsMissing extends Error {
  readonly looked: ReadonlyArray<string>

  constructor(looked: ReadonlyArray<string>) {
    super(
      `the voyager build is missing. Run \`${BUILD_COMMAND}\`, then start again. Looked in: ${looked.join(", ")}`
    )
    this.name = "AssetsMissing"
    this.looked = looked
  }
}

const holdsIndex = (directory: string): boolean => existsSync(`${directory}/${INDEX_FILE}`)

// assetsIn is the resolution rule as a pure function of the places to look, so a test states its
// own places (assets.test.ts).
export const assetsIn = (candidates: ReadonlyArray<string>): string => {
  const found = candidates.find(holdsIndex)
  if (found === undefined) throw new AssetsMissing(candidates)
  return found
}

// resolveAssets answers the directory to serve. A stated directory is taken as stated, and is still
// checked for the index file, so a typo fails at boot rather than as a blank page.
export const resolveAssets = (stated?: string | undefined): string =>
  assetsIn(
    stated === undefined
      ? ASSET_CANDIDATES.map((candidate) => fileURLToPath(new URL(candidate, import.meta.url)).replace(/\/$/, ""))
      : [stated.replace(/\/$/, "")]
  )
