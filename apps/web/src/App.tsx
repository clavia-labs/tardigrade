import { useState, type ReactElement } from "react"
import markUrl from "../../../docs/assets/logo-dark-geometric.svg"
import { ComponentBridge } from "./ComponentBridge"
import { FlowOverlay } from "./FlowOverlay"
import { IsometricEventLog } from "./IsometricEventLog"
import { WorldGlobe } from "./WorldGlobe"

const REPOSITORY = "https://github.com/clavia-labs/tardigrade"
const SHOW_HARNESS_CONTROLS = import.meta.env.VITE_SHOW_HARNESS_CONTROLS === "true"
const STARTER_PROMPT = `Build a durable TypeScript agent with Tardigrade. Start from the quickstart at ${REPOSITORY}#quickstart and use the fewest components needed for the task.`

const eventProjections: Readonly<Record<string, { readonly result: string; readonly target: string | undefined }>> = {
  "01": { result: "ToolCalled", target: "02" },
  "02": { result: "ToolReturned", target: "03" },
  "03": { result: "CompactionCompleted", target: "04" },
  "04": { result: "TurnCompleted", target: "05" },
  "05": { result: "[]", target: undefined }
}

const Mark = (): ReactElement => <img className="mark" src={markUrl} alt="" />

const Github = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.6 9.6 0 0 1 12 6.82a9.6 9.6 0 0 1 2.5.34c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.56 4.93.36.31.68.92.68 1.85v2.77c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
  </svg>
)

const CopyIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeWidth="1.8" d="M9 8h9v11H9zM6 16H5V5h9v1" />
  </svg>
)

const CopyPromptButton = (): ReactElement => {
  const [copied, setCopied] = useState(false)

  const copyPrompt = async (): Promise<void> => {
    await navigator.clipboard.writeText(STARTER_PROMPT)
    setCopied(true)
  }

  return (
    <button className="button button-primary" type="button" onClick={() => void copyPrompt()}>
      <CopyIcon />
      {copied ? "Copied" : "Copy prompt"}
    </button>
  )
}

const CelldMark = (): ReactElement => (
  <svg viewBox="0 0 28 28" aria-hidden="true">
    <rect x="2" y="2" width="10" height="10" />
    <rect x="16" y="2" width="10" height="10" />
    <rect x="2" y="16" width="10" height="10" />
    <rect x="16" y="16" width="10" height="10" />
  </svg>
)

type Provider = {
  readonly name: string
  readonly href: string
  readonly icon: string
}

const providers: ReadonlyArray<Provider> = [
  { name: "Cloudflare", href: "https://developers.cloudflare.com/durable-objects/", icon: "https://cdn.simpleicons.org/cloudflare/f38020" },
  { name: "Amazon S3", href: "https://aws.amazon.com/s3/", icon: "https://api.iconify.design/logos/aws-s3.svg" },
  { name: "Google Compute", href: "https://cloud.google.com/products/compute", icon: "https://cdn.simpleicons.org/googlecloud/4285f4" },
  { name: "Azure", href: "https://azure.microsoft.com/", icon: "https://api.iconify.design/logos/microsoft-azure.svg" },
  { name: "Railway", href: "https://railway.com/", icon: "https://cdn.simpleicons.org/railway/0b0d0e" },
  { name: "DigitalOcean", href: "https://www.digitalocean.com/", icon: "https://cdn.simpleicons.org/digitalocean/0080ff" },
  { name: "MinIO", href: "https://min.io/", icon: "https://cdn.simpleicons.org/minio/c72e49" }
]

type Point = { readonly x: number; readonly y: number }

const puzzlePoint = (start: Point, end: Point, normal: Point, progress: number, offset: number): Point => ({
  x: start.x + (end.x - start.x) * progress + normal.x * offset,
  y: start.y + (end.y - start.y) * progress + normal.y * offset
})

const puzzleCoordinate = ({ x, y }: Point): string => `${x.toFixed(1)} ${y.toFixed(1)}`

const puzzleEdge = (start: Point, end: Point, normal: Point, direction: number): string => {
  if (direction === 0) return `L ${puzzleCoordinate(end)}`
  const depth = Math.hypot(end.x - start.x, end.y - start.y) * 0.13 * direction
  return [
    `L ${puzzleCoordinate(puzzlePoint(start, end, normal, 0.34, 0))}`,
    `C ${puzzleCoordinate(puzzlePoint(start, end, normal, 0.4, 0))} ${puzzleCoordinate(puzzlePoint(start, end, normal, 0.4, depth * 1.3))} ${puzzleCoordinate(puzzlePoint(start, end, normal, 0.5, depth * 1.3))}`,
    `C ${puzzleCoordinate(puzzlePoint(start, end, normal, 0.6, depth * 1.3))} ${puzzleCoordinate(puzzlePoint(start, end, normal, 0.6, 0))} ${puzzleCoordinate(puzzlePoint(start, end, normal, 0.66, 0))}`,
    `L ${puzzleCoordinate(end)}`
  ].join(" ")
}

const puzzleDirection = (row: number, column: number, axis: number): number => (Math.abs(row * 31 + column * 17 + axis * 13) % 2 === 0 ? 1 : -1)

const puzzlePath = (row: number, column: number, size: number, inset: number): string => {
  const left = inset + column * size
  const top = inset + row * size
  const right = left + size
  const bottom = top + size
  return [
    `M ${left} ${top}`,
    puzzleEdge({ x: left, y: top }, { x: right, y: top }, { x: 0, y: -1 }, -puzzleDirection(row - 1, column, 0)),
    puzzleEdge({ x: right, y: top }, { x: right, y: bottom }, { x: 1, y: 0 }, puzzleDirection(row, column, 1)),
    puzzleEdge({ x: right, y: bottom }, { x: left, y: bottom }, { x: 0, y: 1 }, puzzleDirection(row, column, 0)),
    puzzleEdge({ x: left, y: bottom }, { x: left, y: top }, { x: -1, y: 0 }, -puzzleDirection(row, column - 1, 1)),
    "Z"
  ].join(" ")
}

const puzzleLayout = Array.from({ length: 24 }, (_, index) => {
  const row = Math.floor(index / 12)
  const column = index % 12
  return { row, column }
})

const PuzzlePiece = (): ReactElement => (
  <div className="puzzle-art" aria-hidden="true">
    <svg className="puzzle-piece" viewBox="0 -30 1680 340" preserveAspectRatio="xMidYMid meet">
      <defs>
        <pattern id="puzzle-hatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line className="puzzle-hatch-line" x1="0" y1="0" x2="0" y2="9" />
        </pattern>
        <pattern id="puzzle-crosshatch" width="12" height="12" patternUnits="userSpaceOnUse">
          <path className="puzzle-hatch-line" d="M 0 12 L 12 0 M -3 3 L 3 -3 M 9 15 L 15 9" />
        </pattern>
      </defs>
      {puzzleLayout.map((piece) => (
        <path
          className={`puzzle-tone-${(piece.row * 3 + piece.column) % 5}`}
          d={puzzlePath(piece.row, piece.column, 140, 0)}
          key={`${piece.row}-${piece.column}`}
        />
      ))}
    </svg>
  </div>
)

type Tone = "red" | "purple" | "blue" | "number"
type CodeToken = { readonly text: string; readonly tone?: Tone }
type Capability = "memory" | "budget" | "permission" | "code" | "mcp" | "subagents" | "output"
type CodeLine = { readonly tokens: ReadonlyArray<CodeToken>; readonly capability?: Capability }
type CapabilityOption = { readonly id: Capability; readonly label: string }

const token = (text: string, tone?: Tone): CodeToken => ({ text, ...(tone === undefined ? {} : { tone }) })
const plain = (text: string): CodeLine => ({ tokens: [token(text)] })
const highlight = (capability: Capability, ...tokens: ReadonlyArray<CodeToken>): CodeLine => ({ tokens, capability })

const start = (name: string): ReadonlyArray<CodeLine> => [
  { tokens: [token("const", "red"), token(" model = { provider: "), token("\"openai\"", "blue"), token(", default_model: "), token("\"gpt-5.2\"", "blue"), token(" }")] },
  plain(""),
  { tokens: [token("export const", "red"), token(" " + name + " = "), token("actor", "purple"), token("({")] },
  { tokens: [token("  name: "), token("\"" + name + "\"", "blue"), token(",")] },
  plain("  methods: agentMethods,"),
  { tokens: [token("  components: ["), token("infer", "purple"), token("([")] },
  { tokens: [token("    system", "purple"), token("("), token("\"Follow the evidence.\"", "blue"), token("),")] }
]

const end: ReadonlyArray<CodeLine> = [plain("  ], model)]"), plain("})")]

const capabilityOptions: ReadonlyArray<CapabilityOption> = [
  { id: "memory", label: "Compaction" },
  { id: "budget", label: "Budgets" },
  { id: "permission", label: "Permissions" },
  { id: "code", label: "Code mode" },
  { id: "mcp", label: "MCP" },
  { id: "subagents", label: "Subagents" },
  { id: "output", label: "Structured output" }
]

const indent = (depth: number): string => "    " + "  ".repeat(depth)

const codeFor = (active: ReadonlySet<Capability>): ReadonlyArray<CodeLine> => {
  const lines: Array<CodeLine> = [...start("researcher")]
  if (active.has("memory")) {
    lines.push(highlight("memory", token("    compaction", "purple"), token("({ fireRatio: "), token("0.8", "number"), token(", keepRatio: "), token("0.5", "number"), token(" }),")))
  }

  let depth = 0
  if (active.has("budget")) {
    lines.push(highlight("budget", token(indent(depth) + "budget", "purple"), token("([")))
    depth += 1
  }
  if (active.has("permission")) {
    lines.push(highlight("permission", token(indent(depth) + "permissions", "purple"), token("([")))
    depth += 1
  }
  if (active.has("code") || active.has("mcp") || active.has("subagents")) {
    const codeModeLine = [token(indent(depth) + "codeMode", "purple"), token("([")]
    lines.push(active.has("code") ? highlight("code", ...codeModeLine) : { tokens: codeModeLine })
    depth += 1
    if (active.has("code")) {
      lines.push(plain(indent(depth) + "filesPackage(),"))
      lines.push(plain(indent(depth) + "fetchPackage(),"))
    }
    if (active.has("mcp")) {
      lines.push(highlight("mcp", token(indent(depth) + "mcpPackage", "purple"), token("(),")))
    }
    if (active.has("subagents")) {
      lines.push(highlight("subagents", token(indent(depth) + "agentsPackage", "purple"), token("(),")))
      lines.push(plain(indent(depth) + "workspacePackage()"))
    }
    depth -= 1
    lines.push(plain(indent(depth) + "]),"))
  }
  if (active.has("permission")) {
    depth -= 1
    lines.push(plain(indent(depth) + "], { authority: caller() }),"))
  }
  if (active.has("budget")) {
    depth -= 1
    lines.push(plain(indent(depth) + "], { limit: 12 }),"))
  }
  if (active.has("output")) {
    lines.push(highlight("output", token("    nativeOutput", "purple"), token(",")))
  }
  return [...lines, ...end]
}

const CodeExample = (): ReactElement => {
  const [active, setActive] = useState<ReadonlySet<Capability>>(() => new Set(capabilityOptions.map((option) => option.id)))
  const code = codeFor(active)
  const toggle = (capability: Capability): void => {
    setActive((current) => {
      const next = new Set(current)
      if (next.has(capability)) next.delete(capability)
      else next.add(capability)
      return next
    })
  }

  return (
    <div className="demo">
      <div className="code-card">
        <div className="code-filename">
          <span className="file-icon" />actor.ts
        </div>
        <pre><code>{code.map((line, index) => <span className={line.capability === undefined ? "code-line" : `code-line line-${line.capability}`} key={index}>{line.tokens.map((part, partIndex) => <span className={part.tone === undefined ? undefined : `token-${part.tone}`} key={partIndex}>{part.text}</span>)}</span>)}</code></pre>
      </div>
      {SHOW_HARNESS_CONTROLS ? (
        <div className="harness-switcher" aria-label="Agent harness capabilities">
          {capabilityOptions.map((option) => (
            <button className="harness-button" data-harness={option.id} type="button" aria-pressed={active.has(option.id)} key={option.id} onClick={() => toggle(option.id)}>
              <span className="toggle-mark" aria-hidden="true">{active.has(option.id) ? "−" : "+"}</span>{option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

const HowItWorks = (): ReactElement => {
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null)
  const selectEvent = (sequence: string): void => setSelectedEvent((current) => current === sequence ? null : sequence)
  const projection = selectedEvent === null ? undefined : eventProjections[selectedEvent]

  return (
    <section className="how-it-works">
      <div className="how-inner">
        <div className="how-copy">
          <h2>How it works</h2>
          <p>Every event is written to a durable log. Components read that log, act on the world, and write the result back until the turn is complete.</p>
        </div>
        <div className="event-table-card">
          <div className={`actor-world-grid${projection === undefined ? "" : " is-tracing"}`}>
            {selectedEvent === null || projection === undefined ? null : <FlowOverlay selectedSequence={selectedEvent} targetSequence={projection.target} />}
            <div className="actor-log-panel">
              <IsometricEventLog selectedSequence={selectedEvent} derivedSequence={projection?.target} onSelect={selectEvent} />
            </div>
            <ComponentBridge />
            <div className="world-panel">
              <WorldGlobe />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

const Durability = (): ReactElement => (
  <section className="durability">
    <div className="durability-inner">
      <div className="durability-copy">
        <h2>Extremely durable.</h2>
        <p>Tardigrades are among the most resilient animals on Earth. They survive hostile conditions by pausing until the world is safe again. Tardigrade agents do the same: processes can disappear, while the durable log lets new ones resume unfinished work.</p>
      </div>
      <figure className="durability-figure">
        <div className="durability-image-frame">
          <img src="/images/tardigrade-microscope.jpg" alt="A scientific illustration of a tardigrade" />
        </div>
        <figcaption>
          <span>FIG. 02</span>
          <a href="https://www.umontpellier.fr/en/articles/le-mystere-de-la-resistance-extreme-des-tardigrades-enfin-resolu" rel="noreferrer" target="_blank">Illustration: SciePro</a>
        </figcaption>
      </figure>
    </div>
  </section>
)

const Deployments = (): ReactElement => (
  <section className="deployments">
    <div className="deployments-inner">
      <div className="deployments-copy">
        <h2>Self-host on your own stack.</h2>
        <p>Run the same actor on your own cloud with Celld or deploy it to Cloudflare.</p>
      </div>
      <div className="provider-grid">
        <a className="provider" href={`${REPOSITORY}/blob/main/docs/how-to/celld.md`} rel="noreferrer" target="_blank">
          <span className="provider-icon provider-icon-celld"><CelldMark /></span>
          <span className="provider-name">Celld</span>
        </a>
        {providers.map((provider) => (
          <a className="provider" href={provider.href} key={provider.name} rel="noreferrer" target="_blank">
            <span className="provider-icon"><img src={provider.icon} alt="" /></span>
            <span className="provider-name">{provider.name}</span>
          </a>
        ))}
      </div>
    </div>
  </section>
)

export const App = (): ReactElement => (
  <>
    <header className="site-header">
      <nav className="nav-inner" aria-label="Main navigation">
        <a className="brand" href="/" aria-label="Tardigrade home"><Mark /><span>Tardigrade</span></a>
        <div className="nav-links">
          <a href={`${REPOSITORY}/blob/main/docs/quickstart.md`} rel="noreferrer" target="_blank">Guide</a>
          <a href={`${REPOSITORY}/tree/main/docs`} rel="noreferrer" target="_blank">Reference</a>
          <a href={`${REPOSITORY}/blob/main/docs/how-to/cli.md`} rel="noreferrer" target="_blank">CLI</a>
          <a href={`${REPOSITORY}/tree/main/apps/voyager`} rel="noreferrer" target="_blank">Voyager</a>
        </div>
        <div className="nav-actions">
          <a className="docs-link" href={`${REPOSITORY}/tree/main/docs`} rel="noreferrer" target="_blank">Docs</a>
          <a className="github-link" href={REPOSITORY} aria-label="Tardigrade on GitHub" rel="noreferrer" target="_blank"><Github /></a>
        </div>
      </nav>
    </header>

    <main>
      <section className="hero">
        <PuzzlePiece />
        <div className="hero-inner">
          <div className="hero-copy">
            <h1><span>Build complex agents</span><span>from simple components.</span></h1>
            <p>Build modular cloud agents and self-host them as Durable Objects.</p>
            <div className="hero-actions">
              <CopyPromptButton />
              <a className="button button-secondary" href={REPOSITORY} rel="noreferrer" target="_blank"><Github />View GitHub</a>
            </div>
          </div>
          <CodeExample />
        </div>
      </section>
      <HowItWorks />
      <Durability />
      <Deployments />
    </main>
  </>
)
