import { componentPurityViolations } from "./component-purity"

let violations = 0
for await (const file of new Bun.Glob("{packages,platform,apps,examples,e2e}/**/*.{ts,tsx}").scan(".")) {
  if (file.includes("node_modules/") || file.includes("/.output/") || file.includes("/dist/") || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) continue
  const source = await Bun.file(file).text()
  for (const violation of componentPurityViolations(file, source)) {
    console.error(`${file}:${violation.line}: component evaluation cannot use ${violation.api}; defer external work to an effect`)
    violations += 1
  }
}
if (violations > 0) process.exitCode = 1
else console.log("Component purity boundaries pass")
