import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"

const root = join(import.meta.dir, "..")
const temporary = await mkdtemp(join(tmpdir(), "flamecast-package-"))

const run = async (command: ReadonlyArray<string>, cwd: string) => {
  const process = Bun.spawn([...command], { cwd, stdout: "inherit", stderr: "inherit" })
  const code = await process.exited
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}`)
}

try {
  const built = join(temporary, "dist")
  await run(["bun", "--bun", "node_modules/.bin/tsdown", "--out-dir", built], root)
  await run(["diff", "-qr", join(root, "dist"), built], root)
  const packed = Bun.spawnSync(["bun", "pm", "pack", "--ignore-scripts", "--destination", temporary], {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit"
  })
  if (packed.exitCode !== 0) throw new Error(`bun pm pack exited ${packed.exitCode}`)

  const output = new TextDecoder().decode(packed.stdout).trim()
  const archive = output.split(/\r?\n/).findLast((line) => line.endsWith(".tgz"))
  if (archive === undefined) throw new Error(`could not find package archive in output: ${output}`)
  const archivePath = isAbsolute(archive) ? archive : join(temporary, archive)

  const consumer = join(temporary, "consumer")
  await mkdir(consumer)
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ type: "module", dependencies: { "flamecast-core": `file:${archivePath}` } })
  )
  await writeFile(
    join(consumer, "index.ts"),
    [
      'import { EventLog } from "flamecast-core"',
      'import { createAgent, inference } from "flamecast-core/harness"',
      'import { MemoryRuntime } from "flamecast-core/runtime-memory"',
      'import { candidate } from "flamecast-core/evolve"',
      "",
      'const agent = createAgent({ id: "smoke", modules: [inference()] })',
      'const value = candidate("candidate", agent)',
      'console.log(typeof EventLog === "function" && typeof MemoryRuntime === "function" && value.id === "candidate")',
      ""
    ].join("\n")
  )
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler", target: "es2023", noEmit: true } })
  )

  await run(["bun", "install"], consumer)
  await run(["bun", "--bun", join(root, "node_modules/.bin/tsc"), "--noEmit"], consumer)
  const result = Bun.spawnSync(["bun", "run", "index.ts"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
  if (result.exitCode !== 0 || new TextDecoder().decode(result.stdout).trim() !== "true") {
    throw new Error("installed package did not execute successfully")
  }

  const manifest = JSON.parse(await readFile(join(consumer, "node_modules/flamecast-core/package.json"), "utf8")) as {
    exports?: unknown
  }
  if (manifest.exports === undefined) throw new Error("installed package has no exports")
} finally {
  await rm(temporary, { recursive: true, force: true })
}
