import { fileURLToPath } from "node:url"

const entrypoint = new URL("./lifecycle.ts", import.meta.url)
const bundle = await Bun.build({
  entrypoints: [fileURLToPath(entrypoint)], target: "node", packages: "external",
  define: { "import.meta.url": JSON.stringify(entrypoint.href) },
})
if (!bundle.success) throw new AggregateError(bundle.logs, "Could not build the heavy workspace runner")
const child = Bun.spawn(["node", "--input-type=module", "--eval", await bundle.outputs[0]!.text()], {
  cwd: fileURLToPath(new URL("../../../", import.meta.url)), stdin: "inherit", stdout: "inherit", stderr: "inherit",
})
process.exitCode = await child.exited
