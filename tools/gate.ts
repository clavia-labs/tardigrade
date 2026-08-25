import { availableParallelism } from "node:os"
import { basename, relative } from "node:path"
import { fileURLToPath } from "node:url"

type Task = {
  readonly id: string
  readonly cmd: ReadonlyArray<string>
  readonly cwd?: string
}

const root = fileURLToPath(new URL("../", import.meta.url))
const pkg = (name: string) => `${root}packages/${name}`
const packages = ["core", "code", "agent", "host", "channels", "client"]
const platformPkg = (name: string) => `${root}platform/${name}`
const platforms = ["model", "bun", "worker-loader", "cloudflare"]
const appPkg = (name: string) => `${root}apps/${name}`
const apps = ["cli", "server", "voyager"]
// Apps that ship a bundle. A typecheck proves the sources agree; only a build proves the bundler
// can resolve and emit them.
const bundled = ["voyager"]

const tsconfigsIn = (directory: string): ReadonlyArray<string> =>
  [...new Bun.Glob("tsconfig*.json").scanSync({ cwd: directory, absolute: true, onlyFiles: true })]
    .filter((path) => basename(path) !== "tsconfig.base.json" && basename(path) !== "tsconfig.effect.json")
    .sort()

const effectProjects = [
  ...tsconfigsIn(root),
  ...packages.flatMap((name) => tsconfigsIn(pkg(name))),
  ...platforms.flatMap((name) => tsconfigsIn(platformPkg(name))),
  ...apps.flatMap((name) => tsconfigsIn(appPkg(name)))
]

const effectTaskId = (project: string): string => {
  const path = relative(root, project).replaceAll("\\", "/")
  if (path === "tsconfig.json") return "lint:effect:tools"
  return `lint:effect:${path
    .replace(/\/tsconfig(?:\.([^.]+))?\.json$/, (_match, variant: string | undefined) => variant === undefined ? "" : `:${variant}`)
    .replaceAll("/", ":")}`
}

// effectLint runs the Effect rules at the severities tsconfig.effect.json states. `--strict` makes
// warnings fail, and one process per project lets the gate run the checks in parallel.
const effectLint = (project: string): ReadonlyArray<string> => [
  "bun",
  "--bun",
  "node_modules/.bin/effect-tsgo",
  "diagnostics",
  "--strict",
  "--format",
  "text",
  "--project",
  project
]

const tasks: ReadonlyArray<Task> = [
  { id: "lint", cmd: ["bun", "--bun", "node_modules/.bin/oxlint"] },
  // Prose carries house rules the code linter does not know, so it has its own check.
  { id: "lint:docs", cmd: ["bun", "run", "tools/docs-lint.ts"] },
  { id: "lint:effect:policy", cmd: ["bun", "run", "tools/effect-lint-policy.ts"] },
  ...effectProjects.map((project) => ({ id: effectTaskId(project), cmd: effectLint(project) })),
  // Root tsconfig covers tools/*.ts; each package typechecks itself against the shared base.
  { id: "typecheck:tools", cmd: ["bun", "--bun", "node_modules/.bin/tsc", "--noEmit"] },
  ...packages.map((name) => ({ id: `typecheck:${name}`, cwd: pkg(name), cmd: ["bun", "run", "typecheck"] })),
  ...platforms.map((name) => ({ id: `typecheck:platform-${name}`, cwd: platformPkg(name), cmd: ["bun", "run", "typecheck"] })),
  ...apps.map((name) => ({ id: `typecheck:app-${name}`, cwd: appPkg(name), cmd: ["bun", "run", "typecheck"] })),
  ...packages.map((name) => ({ id: `test:${name}`, cwd: pkg(name), cmd: ["bun", "test"] })),
  ...platforms.map((name) => ({ id: `test:platform-${name}`, cwd: platformPkg(name), cmd: ["bun", "test"] })),
  { id: "test:platform-cloudflare:workers", cwd: platformPkg("cloudflare"), cmd: ["bun", "run", "test:workers"] },
  { id: "test:platform-worker-loader:workers", cwd: platformPkg("worker-loader"), cmd: ["bun", "run", "test:workers"] },
  ...apps.map((name) => ({ id: `test:app-${name}`, cwd: appPkg(name), cmd: ["bun", "test"] })),
  { id: "bundle:platform-cloudflare", cwd: platformPkg("cloudflare"), cmd: ["bun", "run", "bundle"] },
  ...bundled.map((name) => ({ id: `build:app-${name}`, cwd: appPkg(name), cmd: ["bun", "run", "build"] })),
  // Knip checks the complete graph, the shipped graph, cycles, and tsconfig discovery as separate views.
  { id: "knip", cmd: ["bun", "run", "knip"] },
  { id: "knip:production", cmd: ["bun", "--bun", "node_modules/.bin/knip", "--production", "--no-progress", "--treat-config-hints-as-errors", "--treat-tag-hints-as-errors"] },
  { id: "knip:cycles", cmd: ["bun", "--bun", "node_modules/.bin/knip", "--cycles", "--no-progress"] },
  { id: "knip:tsconfigs", cmd: ["bun", "--bun", "node_modules/.bin/knip", "--use-tsconfig-files", "--no-progress", "--treat-config-hints-as-errors", "--treat-tag-hints-as-errors"] }
]

const args = process.argv.slice(2)
const readArg = (name: string) => {
  const i = args.indexOf(`--${name}`)
  if (i !== -1) return args[i + 1]
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
}
const only = readArg("only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? []
const selected = tasks.filter((t) => only.length === 0 || only.some((p) => t.id === p || t.id.startsWith(`${p}:`)))
const jobs = Math.min(Math.max(availableParallelism(), 2), 8)

if (args.includes("--list")) {
  for (const task of tasks) console.log(task.id)
  process.exit(0)
}

const formatMs = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`)

// Interleaved output is unreadable without a tag, so every line carries its task id.
const pipe = async (id: string, stream: ReadableStream<Uint8Array> | null) => {
  if (!stream) return
  const decoder = new TextDecoder()
  let carry = ""
  for await (const chunk of stream) {
    carry += decoder.decode(chunk, { stream: true })
    const lines = carry.split(/\r?\n/)
    carry = lines.pop() ?? ""
    for (const line of lines) console.log(`[${id}] ${line}`)
  }
  if (carry.length > 0) console.log(`[${id}] ${carry}`)
}

const run = async (task: Task) => {
  const started = Date.now()
  console.log(`\n> ${task.id}  ${task.cmd.join(" ")}`)
  const proc = Bun.spawn([...task.cmd], { cwd: task.cwd ?? root, stdout: "pipe", stderr: "pipe" })
  const drained = Promise.all([pipe(task.id, proc.stdout), pipe(task.id, proc.stderr)])
  const code = await proc.exited
  await drained
  const ms = Date.now() - started
  console.log(code === 0 ? `PASS ${task.id} ${formatMs(ms)}` : `FAIL ${task.id} exited ${code} after ${formatMs(ms)}`)
  return { task, code, ms }
}

console.log(`gate: ${selected.length} tasks, ${jobs} parallel jobs`)
const startedAt = Date.now()
const queue = [...selected]
const results: Array<{ task: Task; code: number; ms: number }> = []
// Every task runs even after a failure: one gate run should surface every problem at once.
await Promise.all(
  Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let task = queue.shift(); task !== undefined; task = queue.shift()) results.push(await run(task))
  })
)

console.log("\nSummary")
for (const r of results.sort((a, b) => b.ms - a.ms)) {
  console.log(`  ${r.code === 0 ? "PASS" : "FAIL"} ${r.task.id.padEnd(18)} ${formatMs(r.ms)}`)
}
console.log(`  total ${formatMs(Date.now() - startedAt)}`)

process.exit(results.some((r) => r.code !== 0) ? 1 : 0)
