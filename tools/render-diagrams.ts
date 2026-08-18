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
  reactor -->|"transitions = f(log)"| transitions["transitions"]
  transitions -->|"keys the log does not record"| act["act(input)"]
  act -->|"events, keyed record last"| log`,
  "agent-loop": `flowchart TB
  log[("event log")]
  log --> infer & tools & compaction
  infer -->|"ToolCalled or TurnCompleted"| log
  tools -->|"ToolReturned"| log
  compaction -->|"CompactionCompleted"| log`
}

const LIGHT = { bg: "#ffffff", fg: "#1f2328", accent: "#d97706", muted: "#656d76" }
const DARK = { bg: "#0d1117", fg: "#e6edf3", accent: "#f59e0b", muted: "#8b949e" }

// One SVG per diagram, theme-aware on its own: the light palette lives on :root, the dark one
// under prefers-color-scheme. beautiful-mermaid routes every color through the custom
// properties, so swapping the tokens swaps the whole diagram, with no second file and no
// <picture> wrapper at the embed site.
const themed = (svg: string): string => {
  const stripped = svg.replace(/style="[^"]*"/, 'style="background:var(--bg)"')
  const tokens = (t: typeof LIGHT) => `--bg:${t.bg};--fg:${t.fg};--accent:${t.accent};--muted:${t.muted};`
  return stripped.replace(
    "<style>",
    `<style>\n  :root { ${tokens(LIGHT)} }\n  @media (prefers-color-scheme: dark) { :root { ${tokens(DARK)} } }\n`
  )
}

for (const [name, source] of Object.entries(DIAGRAMS)) {
  const svg = renderMermaidSVG(source, { ...LIGHT, font: "ui-sans-serif", padding: 16 }).replace(
    /@import url\('https:\/\/fonts\.googleapis\.com[^']*'\);?/g,
    ""
  )
  writeFileSync(`${root}docs/assets/${name}.svg`, themed(svg))
  console.log(`docs/assets/${name}.svg`)
}
