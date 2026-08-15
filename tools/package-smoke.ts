import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"

const root = join(import.meta.dir, "..")
const temporary = await mkdtemp(join(tmpdir(), "flamecast-package-"))
const localGitEnvironment = Bun.spawnSync(["git", "rev-parse", "--local-env-vars"], {
  cwd: root,
  stdout: "pipe",
  stderr: "inherit"
})
if (localGitEnvironment.exitCode !== 0) throw new Error("could not read the local Git environment")
const environment = { ...process.env }
for (const name of new TextDecoder().decode(localGitEnvironment.stdout).trim().split("\n")) {
  if (name !== "") delete environment[name]
}

const run = async (command: ReadonlyArray<string>, cwd: string) => {
  const process = Bun.spawn([...command], {
    cwd,
    env: environment,
    stdout: "inherit",
    stderr: "inherit"
  })
  const code = await process.exited
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}`)
}

const outputOf = (command: ReadonlyArray<string>, cwd: string) => {
  const process = Bun.spawnSync([...command], {
    cwd,
    env: environment,
    stdout: "pipe",
    stderr: "inherit"
  })
  if (process.exitCode !== 0) throw new Error(`${command.join(" ")} exited ${process.exitCode}`)
  return new TextDecoder().decode(process.stdout).trim()
}

const copySource = async (destination: string) => {
  const deleted = new Set(
    outputOf(["git", "ls-files", "--deleted", "-z"], root)
      .split("\0")
      .filter((file) => file.length > 0)
  )
  const files = outputOf(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], root)
    .split("\0")
    .filter((file) => file.length > 0 && !deleted.has(file))

  if (files.some((file) => file === "dist" || file.startsWith("dist/"))) {
    throw new Error("dist must not be tracked or included in a clean source checkout")
  }

  for (const file of files) {
    const source = join(root, file)
    const target = join(destination, file)
    await mkdir(dirname(target), { recursive: true })
    const metadata = await lstat(source)
    if (metadata.isSymbolicLink()) await symlink(await readlink(source), target)
    else await copyFile(source, target)
  }
}

const withGitServer = async (directory: string, use: (url: string) => Promise<void>) => {
  const root = resolve(directory)
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = resolve(root, `.${decodeURIComponent(new URL(request.url).pathname)}`)
      if (path !== root && !path.startsWith(`${root}${sep}`)) return new Response("not found", { status: 404 })
      const file = Bun.file(path)
      if (!(await file.exists())) return new Response("not found", { status: 404 })
      return new Response(file)
    }
  })

  try {
    await use(`git+http://${server.hostname}:${server.port}/source.git`)
  } finally {
    server.stop(true)
  }
}

try {
  const source = join(temporary, "source")
  await mkdir(source)
  await copySource(source)
  await run(["git", "init", "--quiet"], source)
  await run(["git", "config", "user.email", "package-smoke@flamecast.invalid"], source)
  await run(["git", "config", "user.name", "Package Smoke"], source)
  await run(["git", "add", "--all"], source)
  await run(["git", "commit", "--quiet", "-m", "test: create clean package source"], source)
  await run(["git", "tag", "package-smoke"], source)
  const served = join(temporary, "served")
  await mkdir(served)
  const repository = join(served, "source.git")
  await run(["git", "clone", "--quiet", "--bare", source, repository], temporary)
  await run(["git", "--git-dir", repository, "update-server-info"], temporary)

  const consumer = join(temporary, "consumer")
  await mkdir(consumer)
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "package-smoke-consumer", private: true, type: "module" })
  )
  await writeFile(
    join(consumer, "index.ts"),
    [
      'import { Effect, Layer } from "effect"',
      'import { EventLog, type Event } from "flamecast-core"',
      'import { createAgent, inference, inferWith, keyOf } from "flamecast-core/harness"',
      'import { codemode, capability, inProcessSandbox, Sandbox } from "flamecast-core/codemode"',
      'import { InMemoryRuntime } from "flamecast-core/runtime-in-memory"',
      'import { candidate, reflectivePrompts } from "flamecast-core/evolve"',
      "",
      'const agent = createAgent({ id: "smoke", modules: [inference()] })',
      'const value = candidate("candidate", agent)',
      "// The reflective proposer is part of the published surface: its declaration reaches into the",
      "// harness for the session types, so an installed consumer proves that rollup landed.",
      "const mutate = reflectivePrompts()",
      'const input: Event = { type: "MessageReceived" }',
      "const execute = codemode({",
      "  capabilities: [",
      "    capability({",
      '      name: "smoke",',
      '      summary: "A capability for the package smoke test.",',
      "      methods: [",
      "        {",
      '          name: "ping",',
      '          signature: "ping(): Promise<string>",',
      '          description: "Answer with a fixed value.",',
      '          run: () => Effect.succeed("pong")',
      "        }",
      "      ]",
      "    })",
      "  ]",
      "})",
      "const script = await Effect.runPromise(",
      "  Effect.provide(",
      '    execute.run({ source: "return await smoke.ping()" }),',
      "    Layer.succeed(Sandbox, inProcessSandbox())",
      "  )",
      ")",
      'const result = await Effect.runPromise(',
      '  agent.turn({ id: "message-1", text: "Say hello." }).pipe(',
      '    Effect.provide(inferWith(async () => ({ kind: "complete", output: "hello" }))),',
      '    Effect.provide(InMemoryRuntime({ keyOf, session: "smoke" }))',
      '  )',
      ')',
      'console.log(',
      '  typeof EventLog === "function" &&',
      '    input.type === "MessageReceived" &&',
      '    typeof InMemoryRuntime === "function" &&',
      '    value.id === "candidate" &&',
      '    typeof mutate === "function" &&',
      '    (script as { value?: unknown }).value === "pong" &&',
      '    result.kind === "completed" &&',
      '    result.output === "hello"',
      ')',
      ""
    ].join("\n")
  )
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "esnext",
        moduleResolution: "bundler",
        target: "es2023",
        lib: ["es2023", "dom", "esnext.disposable"],
        noEmit: true
      }
    })
  )

  await withGitServer(served, async (url) => {
    await run(["bun", "add", "--trust", `${url}#package-smoke`], consumer)
    await run(["bun", "--bun", join(root, "node_modules/.bin/tsc"), "--noEmit"], consumer)
    if (outputOf(["bun", "run", "index.ts"], consumer) !== "true") {
      throw new Error("installed package did not execute successfully")
    }
  })

  const manifest = JSON.parse(await readFile(join(consumer, "node_modules/flamecast-core/package.json"), "utf8")) as {
    exports?: unknown
  }
  if (manifest.exports === undefined) throw new Error("installed package has no exports")
} finally {
  await rm(temporary, { recursive: true, force: true })
}
