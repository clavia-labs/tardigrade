import { renderMermaidSVG } from "beautiful-mermaid"
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// The README's diagrams, rendered to committed SVGs so GitHub shows the house style instead of
// its own mermaid theme. One light and one dark variant per diagram; the README picks with a
// <picture> media query. Re-run after editing a source here: bun run tools/render-diagrams.ts

const root = fileURLToPath(new URL("../", import.meta.url))

const DIAGRAMS: Record<string, string> = {
  "reconciler-loop": `flowchart TB
  log[("event log")] -->|"events"| reactor["reactor"]
  reactor -->|"{transitions} = f(log)"| transitions["transitions"]
  transitions -->|"unrecorded keys fire"| act["act(input)"]
  act -->|"events, keyed record last"| log`
}

const LIGHT = { bg: "#ffffff", fg: "#1f2328", accent: "#d97706", muted: "#656d76" }
const DARK = { bg: "#0d1117", fg: "#e6edf3", accent: "#f59e0b", muted: "#8b949e" }

// Two variants per diagram, picked by GitHub's documented <picture> mechanism: an SVG served
// through the image proxy cannot see GitHub's own theme toggle, so the media query on the
// <source> is the reliable seam.
for (const [name, source] of Object.entries(DIAGRAMS)) {
  for (const [mode, colors] of [["light", LIGHT], ["dark", DARK]] as const) {
    const svg = renderMermaidSVG(source, { ...colors, font: "ui-sans-serif", padding: 16 }).replace(
      /@import url\('https:\/\/fonts\.googleapis\.com[^']*'\);?/g,
      ""
    )
    writeFileSync(`${root}docs/assets/${name}-${mode}.svg`, svg)
    console.log(`docs/assets/${name}-${mode}.svg`)
  }
}
