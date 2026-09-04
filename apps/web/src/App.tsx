import { Link } from "@tanstack/react-router"
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react"
import { ComponentBridge } from "./ComponentBridge"
import { FlowOverlay } from "./FlowOverlay"
import { IsometricEventLog } from "./IsometricEventLog"
import { PuzzleGrid } from "./PuzzleGrid"
import { WorldGlobe } from "./WorldGlobe"
import { CheckIcon, CopyIcon, useCopy } from "./ui/copy"

const REPOSITORY = "https://github.com/clavia-labs/tardigrade"
const SHOW_HARNESS_CONTROLS = import.meta.env.VITE_SHOW_HARNESS_CONTROLS === "true"
const INIT_COMMAND = "bunx tardie init"
const STARTER_PROMPT = "Build a durable TypeScript agent with Tardigrade. Start with the quickstart template at https://tardigrade.dev/docs/quickstart and add only the components required for the task."

const eventProjections: Readonly<Record<string, { readonly effect?: string; readonly result: string; readonly target: string | undefined }>> = {
  "01": { effect: "model.generate(log)", result: "ToolCalled", target: "02" },
  "02": { effect: "git.log({ limit: 3 })", result: "ToolReturned", target: "03" },
  "03": { effect: "model.compact(log)", result: "CompactionCompleted", target: "04" },
  "04": { effect: "model.generate(log)", result: "TurnCompleted", target: "05" },
  "05": { result: "[]", target: undefined }
}
const HOW_TRACE_SEQUENCE = ["01", "02", "03", "04", "05"] as const
const HOW_TRACE_STEP_MS = 760

const Mark = (): ReactElement => (
  <svg className="mark" viewBox="36 62 210 136" aria-hidden="true">
    <g transform="translate(320 0) scale(-1 1)">
      <path d="M78 117 112 99v77c0 6-3 10-8 13l-21-11c-3-2-5-5-5-9Z" />
      <path d="M120 95 154 81v96c0 6-3 10-8 13l-21-11c-3-2-5-5-5-9Z" />
      <path d="M162 78c10-4 21-7 34-8v106c0 5-3 9-8 12l-21-11c-3-2-5-5-5-9Z" />
      <path d="M204 70c12 1 23 4 34 8v90c0 4-2 7-5 9l-21 11c-5-3-8-7-8-12Z" />
      <path d="m246 81 34 14v47l-34 14Z" />
    </g>
  </svg>
)

const Github = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.6 9.6 0 0 1 12 6.82a9.6 9.6 0 0 1 2.5.34c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.56 4.93.36.31.68.92.68 1.85v2.77c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
  </svg>
)

const MenuIcon = (): ReactElement => (
  <span className="mobile-menu-icon" aria-hidden="true">
    <span />
    <span />
  </span>
)

const Discord = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M19.5 5.3A17.2 17.2 0 0 0 15.3 4l-.5 1a16 16 0 0 0-5.6 0l-.5-1a17.1 17.1 0 0 0-4.2 1.3C1.8 9.3 1 13.2 1.4 17a17 17 0 0 0 5.2 2.6l1.3-1.8-1.8-.9.4-.3a12.2 12.2 0 0 0 11 0l.4.3-1.8.9 1.3 1.8a17 17 0 0 0 5.2-2.6c.5-4.4-.8-8.2-3.1-11.7ZM8.5 15.1c-1.3 0-2.3-1.2-2.3-2.6 0-1.5 1-2.6 2.3-2.6 1.3 0 2.3 1.2 2.3 2.6 0 1.5-1 2.6-2.3 2.6Zm7 0c-1.3 0-2.3-1.2-2.3-2.6 0-1.5 1-2.6 2.3-2.6 1.3 0 2.3 1.2 2.3 2.6 0 1.5-1 2.6-2.3 2.6Z" />
  </svg>
)

const GuideIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeLinecap="square" strokeWidth="1.6" d="M4 5.5c2.7-.8 5.3-.3 8 1.5v12c-2.7-1.8-5.3-2.3-8-1.5Zm16 0c-2.7-.8-5.3-.3-8 1.5v12c2.7-1.8 5.3-2.3 8-1.5Z" />
  </svg>
)

const MoonIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" /></svg>
)

const SunIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" /></svg>
)

const ThemeToggle = (): ReactElement => {
  const [dark, setDark] = useState(false)
  useEffect(() => setDark(document.documentElement.dataset.theme === "dark"), [])
  const toggle = (): void => {
    const nextDark = !dark
    const theme = nextDark ? "dark" : "light"
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem("tardigrade-theme", theme)
    setDark(nextDark)
  }
  return (
    <button className="theme-toggle" type="button" aria-label={`Use ${dark ? "light" : "dark"} mode`} title={`Use ${dark ? "light" : "dark"} mode`} aria-pressed={dark} onClick={toggle}>
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}

const CopyPromptButton = (): ReactElement => {
  const [copied, copy] = useCopy()

  return (
    <button className="button button-primary" type="button" onClick={() => void copy(STARTER_PROMPT)}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? "Copied" : "Copy prompt"}
    </button>
  )
}

const CommandLine = ({ command, label }: { readonly command: string; readonly label: string }): ReactElement => {
  const [copied, copy] = useCopy()

  return (
    <div className="install-command" aria-label={label}>
      <span aria-hidden="true">$</span>
      <code>{command}</code>
      <button type="button" aria-label={copied ? "Command copied" : "Copy command"} title={copied ? "Copied" : "Copy command"} onClick={() => void copy(command)}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  )
}

const InstallCommand = (): ReactElement => <CommandLine command={INIT_COMMAND} label="Install Tardigrade" />

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

const puzzleRows = ["111111111111", "111111111111"]

const PuzzlePiece = (): ReactElement => (
  <div className="puzzle-art" aria-hidden="true">
    <PuzzleGrid className="puzzle-piece" connectors="all" pathClassName={(row, column) => `puzzle-tone-${(row * 3 + column) % 5}`} preserveAspectRatio="xMidYMid meet" rows={puzzleRows} size={140} tabRatio={0.13} viewBox="0 -30 1680 340">
      <defs>
        <pattern id="puzzle-hatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line className="puzzle-hatch-line" x1="0" y1="0" x2="0" y2="9" />
        </pattern>
        <pattern id="puzzle-crosshatch" width="12" height="12" patternUnits="userSpaceOnUse">
          <path className="puzzle-hatch-line" d="M 0 12 L 12 0 M -3 3 L 3 -3 M 9 15 L 15 9" />
        </pattern>
      </defs>
    </PuzzleGrid>
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
  plain(""),
  { tokens: [token("export const", "red"), token(" " + name + " = "), token("actor", "purple"), token("({")] },
  { tokens: [token("  name: "), token("\"" + name + "\"", "blue"), token(",")] },
  plain("  methods: agentMethods,"),
  { tokens: [token("  components: ["), token("infer", "purple"), token("([")] },
  { tokens: [token("    system", "purple"), token("("), token("\"You are a friendly research assistant.\"", "blue"), token("),")] }
]

const end: ReadonlyArray<CodeLine> = [plain("  ])]"), plain("})")]

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
  const sectionRef = useRef<HTMLElement | null>(null)
  const autoplayTimerRef = useRef<number | null>(null)
  const hasAutoplayedRef = useRef(false)
  const cancelAutoplay = (): void => {
    if (autoplayTimerRef.current === null) return
    window.clearTimeout(autoplayTimerRef.current)
    autoplayTimerRef.current = null
  }
  const selectEvent = (sequence: string): void => {
    cancelAutoplay()
    setSelectedEvent((current) => current === sequence ? null : sequence)
  }
  const projection = selectedEvent === null ? undefined : eventProjections[selectedEvent]

  useEffect(() => {
    const section = sectionRef.current
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const narrowScreen = window.matchMedia("(max-width: 1140px)")
    if (section === null || reducedMotion.matches || narrowScreen.matches) return

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || hasAutoplayedRef.current) return
      hasAutoplayedRef.current = true
      observer.disconnect()
      let index = 0
      const advance = (): void => {
        const sequence = HOW_TRACE_SEQUENCE[index]
        if (sequence === undefined) {
          setSelectedEvent(null)
          autoplayTimerRef.current = null
          return
        }
        setSelectedEvent(sequence)
        index += 1
        autoplayTimerRef.current = window.setTimeout(advance, HOW_TRACE_STEP_MS)
      }
      autoplayTimerRef.current = window.setTimeout(advance, 180)
    }, { threshold: 0.35 })

    const stopAutoplay = (): void => {
      if (!reducedMotion.matches && !narrowScreen.matches) return
      observer.disconnect()
      cancelAutoplay()
      setSelectedEvent(null)
    }

    observer.observe(section)
    reducedMotion.addEventListener("change", stopAutoplay)
    narrowScreen.addEventListener("change", stopAutoplay)
    return () => {
      observer.disconnect()
      cancelAutoplay()
      reducedMotion.removeEventListener("change", stopAutoplay)
      narrowScreen.removeEventListener("change", stopAutoplay)
    }
  }, [])

  useEffect(() => {
    if (selectedEvent === null) return
    const clearSelection = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest(".event-log-row") !== null) return
      cancelAutoplay()
      setSelectedEvent(null)
    }
    document.addEventListener("pointerdown", clearSelection)
    return () => document.removeEventListener("pointerdown", clearSelection)
  }, [selectedEvent])

  return (
    <section className="how-it-works" ref={sectionRef}>
      <div className="how-inner">
        <div className="how-copy">
          <h2>How it works</h2>
          <p>Every event is written to a durable log. Each component folds those events into state, then derives a view and enabled transitions. The runtime executes those transitions and appends the results to the log until the turn is complete.</p>
        </div>
        <div className="event-table-card">
          <div className={`actor-world-grid${projection === undefined ? "" : " is-tracing"}`}>
            {selectedEvent === null || projection === undefined ? null : <FlowOverlay selectedSequence={selectedEvent} targetSequence={projection.target} key={selectedEvent} />}
            <div className="actor-log-panel">
              <IsometricEventLog selectedSequence={selectedEvent} derivedSequence={projection?.target} onSelect={selectEvent} />
              <span className="diagram-column-label">Log</span>
            </div>
            <div className="component-panel">
              <ComponentBridge />
              <span className="diagram-column-label">Component</span>
            </div>
            <div className="world-panel">
              {projection?.effect === undefined ? null : <span className="world-effect">{projection.effect}</span>}
              <WorldGlobe />
              <span className="diagram-column-label">World</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

const durabilityLogIds = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"] as const

const LogCards = (): ReactElement => (
  <div className="durability-log-cards" aria-hidden="true">
    {durabilityLogIds.map((id) => (
      <span className="durability-log-card" key={id}>
        <span className="log-card-mark" />
        <span className="log-card-rule" />
      </span>
    ))}
  </div>
)

const Durability = (): ReactElement => (
  <section className="durability">
    <div className="durability-inner">
      <div className="durability-copy">
        <h2>Let it crash.</h2>
        <p>Since all of an agent&apos;s state lives in a single log, Tardigrade agents are extremely durable and portable. The name comes from the nearly indestructible animals that survive extreme conditions by entering a dormant tun state.</p>
      </div>
      <figure className="durability-figure">
        <div className="durability-image-frame">
          <LogCards />
          <img src="/images/tardie.png" alt="A technical illustration of a tardigrade" />
        </div>
        <figcaption>
          <span>FIG. 02</span>
          <span>Tardigrade</span>
        </figcaption>
      </figure>
    </div>
  </section>
)

type CityRoad = {
  readonly axis: "u" | "v"
  readonly center: number
  readonly id: string
  readonly width: number
}

type CityPoint = { readonly x: number; readonly y: number }
type CityAgent = CityPoint & { readonly facing?: "left" | "right" }

const crossingRoad: CityRoad = { id: "crossing", axis: "u", center: .3, width: .1 }
const boulevardRoad: CityRoad = { id: "boulevard", axis: "v", center: .57, width: .1 }
const cityRoads: ReadonlyArray<CityRoad> = [crossingRoad, boulevardRoad]
const cityGridUnits = 6
const cityExtent = (cityGridUnits + 1) / cityGridUnits
const cityGridCoordinates = Array.from({ length: cityGridUnits + 2 }, (_, index) => index / cityGridUnits)

const projectCityPoint = (u: number, v: number): CityPoint => ({
  x: 320 + 304 * u - 304 * v,
  y: 18 + 176 * u + 176 * v
})

const roadEdgePoints = (road: CityRoad): string => {
  const low = road.center - road.width / 2
  const high = road.center + road.width / 2
  const points = road.axis === "u"
    ? [projectCityPoint(low, 0), projectCityPoint(high, 0), projectCityPoint(high, cityExtent), projectCityPoint(low, cityExtent)]
    : [projectCityPoint(0, low), projectCityPoint(cityExtent, low), projectCityPoint(cityExtent, high), projectCityPoint(0, high)]
  return points.map(({ x, y }) => `${x},${y}`).join(" ")
}

const roadCenterPoints = (road: CityRoad): readonly [CityPoint, CityPoint] => road.axis === "u"
  ? [projectCityPoint(road.center, 0), projectCityPoint(road.center, cityExtent)]
  : [projectCityPoint(0, road.center), projectCityPoint(cityExtent, road.center)]

const RoadNetwork = (): ReactElement => (
  <g className="scalability-roads" aria-hidden="true">
    {cityRoads.map((road) => {
      const [start, end] = roadCenterPoints(road)
      return <g key={road.id}><polygon className="scalability-road" points={roadEdgePoints(road)} /><line className="scalability-road-mark" x1={start.x} y1={start.y} x2={end.x} y2={end.y} /></g>
    })}
  </g>
)

const roadsideBuildings = [
  { id: "west", road: crossingRoad, along: .68, side: -1 },
  { id: "center", road: crossingRoad, along: .36, side: 1 },
  { id: "east", road: boulevardRoad, along: .76, side: -1 }
] as const

const roadsideBuildingPosition = ({ road, along, side }: (typeof roadsideBuildings)[number]): CityPoint => {
  const offset = side * (road.width / 2 + .1)
  const point = road.axis === "u" ? projectCityPoint(road.center + offset, along) : projectCityPoint(along, road.center + offset)
  return { x: point.x - 18, y: point.y - 68 }
}

const treeCandidates = [
  { id: "northwest", u: .08, v: .3 },
  { id: "northeast", u: .48, v: .15 },
  { id: "west", u: .03, v: .92 },
  { id: "southwest", u: .48, v: .78 },
  { id: "southeast", u: .8, v: .72 }
] as const

const intersectsRoad = ({ u, v }: { readonly u: number; readonly v: number }): boolean => cityRoads.some((road) => {
  const coordinate = road.axis === "u" ? u : v
  return Math.abs(coordinate - road.center) <= road.width / 2
})

const cityTrees = treeCandidates.filter((tree) => !intersectsRoad(tree))

const cityTreePosition = ({ u, v }: (typeof cityTrees)[number]): CityPoint => {
  const point = projectCityPoint(u, v)
  return { x: point.x - 12, y: point.y - 42 }
}

const cityAgents: ReadonlyArray<CityAgent> = [
  { facing: "left", x: 105, y: 182 },
  { x: 116, y: 142 },
  { facing: "left", x: 185, y: 112 },
  { x: 302, y: 54 },
  { facing: "left", x: 458, y: 100 },
  { x: 480, y: 164 },
  { x: 150, y: 230 },
  { facing: "left", x: 302, y: 170 },
  { x: 450, y: 220 },
  { facing: "left", x: 220, y: 275 },
  { facing: "left", x: 300, y: 292 },
  { x: 380, y: 275 }
]

const cityCars: ReadonlyArray<CityPoint> = [
  { x: 104, y: 227 },
  { x: 384, y: 66 },
  { x: 334, y: 224 }
]

const IsometricAgent = ({ facing = "right", x, y }: { readonly facing?: "left" | "right"; readonly x: number; readonly y: number }): ReactElement => (
  <g className="scalability-agent" transform={`translate(${x} ${y}) scale(.82)`}>
    <path className="scalability-agent-shadow" d="M2 53L18 45L34 53L18 61Z" />
    <path className="scalability-agent-top" d="M0 10L18 0L36 10L18 20Z" />
    <path className="scalability-agent-left" d="M0 10L18 20V46L0 36Z" />
    <path className="scalability-agent-right" d="M18 20L36 10V36L18 46Z" />
    <path className="scalability-agent-beak" d={facing === "right" ? "M36 21L46 25L36 29Z" : "M0 21L-10 25L0 29Z"} />
    <circle className="scalability-agent-eye" cx={facing === "right" ? 28 : 8} cy="22" r="1.8" />
    <path className="scalability-agent-detail" d="M11 42L8 52M25 42L28 52M4 52H11M25 52H32" />
  </g>
)

const IsometricBuilding = ({ x, y }: { readonly x: number; readonly y: number }): ReactElement => (
  <g className="scalability-building" transform={`translate(${x} ${y}) scale(.82)`}>
    <path className="scalability-building-top" d="M0 14L22 1L44 14L22 27Z" />
    <path className="scalability-building-left" d="M0 14L22 27V83L0 70Z" />
    <path className="scalability-building-right" d="M22 27L44 14V70L22 83Z" />
    <path className="scalability-building-windows" d="M7 32L15 37M7 47L15 52M7 62L15 67M29 36L37 31M29 51L37 46M29 66L37 61" />
  </g>
)

const IsometricTree = ({ x, y }: { readonly x: number; readonly y: number }): ReactElement => (
  <g className="scalability-tree" transform={`translate(${x} ${y}) scale(.82)`}>
    <path d="M14 0L27 22H21L31 39H-3L7 22H1Z" />
    <path d="M12 39V51H17V39" />
  </g>
)

const IsometricCar = ({ x, y }: { readonly x: number; readonly y: number }): ReactElement => (
  <g className="scalability-car" transform={`translate(${x} ${y}) scale(.82)`}>
    <path className="scalability-car-top" d="M0 8L18 0L38 10L20 18Z" />
    <path className="scalability-car-left" d="M0 8L20 18V28L0 18Z" />
    <path className="scalability-car-right" d="M20 18L38 10V20L20 28Z" />
    <circle cx="8" cy="21" r="3" />
    <circle cx="29" cy="24" r="3" />
  </g>
)

const ScalabilityGrid = (): ReactElement => (
  <figure className="scalability-figure">
    <div className="scalability-image-frame">
      <div className="scalability-grid-clip">
        <svg className="scalability-grid" viewBox="0 0 640 420" role="img" aria-label="A civilisation of boxy isometric birds distributed across an isometric grid.">
          <g className="scalability-grid-lines" aria-hidden="true">
            <polygon points={[projectCityPoint(0, 0), projectCityPoint(cityExtent, 0), projectCityPoint(cityExtent, cityExtent), projectCityPoint(0, cityExtent)].map(({ x, y }) => `${x},${y}`).join(" ")} />
            {cityGridCoordinates.map((coordinate) => {
              const uStart = projectCityPoint(coordinate, 0)
              const uEnd = projectCityPoint(coordinate, cityExtent)
              const vStart = projectCityPoint(0, coordinate)
              const vEnd = projectCityPoint(cityExtent, coordinate)
              return <g key={coordinate}><line x1={uStart.x} y1={uStart.y} x2={uEnd.x} y2={uEnd.y} /><line x1={vStart.x} y1={vStart.y} x2={vEnd.x} y2={vEnd.y} /></g>
            })}
          </g>
          <RoadNetwork />
          <g className="scalability-agents">
            {cityAgents.map((agent) => <IsometricAgent {...agent} key={`${agent.x}-${agent.y}`} />)}
          </g>
          <g className="scalability-buildings">
            {roadsideBuildings.map((building) => <IsometricBuilding {...roadsideBuildingPosition(building)} key={building.id} />)}
          </g>
          <g className="scalability-trees">
            {cityTrees.map((tree) => <IsometricTree {...cityTreePosition(tree)} key={tree.id} />)}
          </g>
          <g className="scalability-cars">
            {cityCars.map((car) => <IsometricCar {...car} key={`${car.x}-${car.y}`} />)}
          </g>
        </svg>
      </div>
    </div>
    <figcaption>
      <span>FIG. 03</span>
      <span>Agent civilisation</span>
    </figcaption>
  </figure>
)

const Scalability = (): ReactElement => (
  <section className="scalability">
    <div className="scalability-inner">
      <div className="scalability-copy">
        <h2>Scalable.</h2>
        <p>Every agent can run as a durable object. Scale from a single agent to swarms of agents.</p>
      </div>
      <ScalabilityGrid />
    </div>
  </section>
)

const TrajectoryField = (): ReactElement => (
  <svg className="trajectory-field" viewBox="0 0 260 300" role="img" aria-label="Agent trajectories" aria-describedby="trajectory-description">
    <desc id="trajectory-description">Several possible agent paths converge into the ordered event log.</desc>
    <g className="trajectory-paths">
      <path d="M0 46C46 28 52 104 92 96S158 130 232 150" />
      <path d="M0 92C36 130 72 50 118 80S174 138 232 150" />
      <path d="M0 152C42 116 70 186 114 164S170 148 232 150" />
      <path d="M0 210C48 234 62 136 118 190S184 152 232 150" />
      <path className="trajectory-path-lead" d="M0 258C52 218 76 264 124 214S176 170 232 150" />
    </g>
    <g className="trajectory-nodes">
      <rect x="88" y="92" width="7" height="7" />
      <rect x="114" y="76" width="7" height="7" />
      <rect x="110" y="160" width="7" height="7" />
      <rect x="121" y="210" width="7" height="7" />
      <rect x="228" y="146" width="9" height="9" />
    </g>
    <path className="trajectory-exit" d="M237 150H260" />
  </svg>
)

const observedEvents = [
  ["01", "root", "MessageReceived", "audit deploy"],
  ["02", "root", "ToolCalled", "agents.run"],
  ["03", "child", "MessageReceived", "research auth"],
  ["04", "root", "PermissionRequestDecided", "read granted"],
  ["05", "child", "BudgetRequested", "+2 calls"],
  ["06", "root", "BudgetRequestDecided", "grant 2"],
  ["07", "child", "TurnCompleted", "2 findings"],
  ["08", "root", "ToolReturned", "researcher"],
  ["09", "root", "TurnCompleted", "verified"]
] as const

const Observability = (): ReactElement => (
  <section className="observability">
    <div className="observability-inner">
      <div className="observability-copy">
        <h2>Native observability.</h2>
        <p>The durable log is also the trace. Inspect every message, model call, tool result, compaction, and handoff from the same ordered history that drives the agent.</p>
      </div>
      <div className="observability-visual">
        <TrajectoryField />
        <div className="observability-log" role="img" aria-label="An ordered agent event log">
          <div className="observability-log-header">
            <span>Event log</span>
            <span className="observability-live"><span />Live</span>
          </div>
          <ol>
            {observedEvents.map(([sequence, thread, event, detail]) => (
              <li data-thread={thread} key={sequence}>
                <span>{sequence}</span>
                <em>{thread}</em>
                <strong>{event}</strong>
                <code>{detail}</code>
              </li>
            ))}
          </ol>
        </div>
      </div>
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
        <a className="provider" href={`${REPOSITORY}/blob/main/docs/platforms/celld.mdx`} rel="noreferrer" target="_blank">
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

const ConsoleScene = (): ReactElement => (
  <div className="console-scene" aria-label="A tardigrade floating above Earth">
    <div className="console-log-clouds" aria-hidden="true">
      <div className="console-log-cloud console-log-cloud-a"><span /><span /><span /><span /></div>
      <div className="console-log-cloud console-log-cloud-b"><span /><span /><span /></div>
      <div className="console-log-cloud console-log-cloud-c"><span /><span /><span /><span /></div>
    </div>
    <div className="console-earth"><WorldGlobe /></div>
    <img className="console-tardie" src="/images/tardie.png" alt="A technical illustration of a tardigrade" />
    <span className="console-scene-label console-scene-label-earth">earth / online</span>
  </div>
)

export const ConsolePage = (): ReactElement => (
  <main className="console-page">
    <section className="console-hero">
      <div className="console-copy">
        <h1>Console is<br />coming soon.</h1>
        <p>Deploy, inspect, and operate durable agents from one hosted workspace.</p>
        <div className="console-actions">
          <a className="button button-secondary" href={REPOSITORY} rel="noreferrer" target="_blank"><Github />Follow on GitHub</a>
          <a className="button button-secondary" href="https://discord.gg/Z74jwRxz4k" rel="noreferrer" target="_blank"><Discord />Join Discord</a>
        </div>
      </div>
      <ConsoleScene />
    </section>
  </main>
)

const SiteFooter = (): ReactElement => {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <Link className="footer-brand" to="/" aria-label="Tardigrade home"><Mark /><span>Tardigrade</span></Link>
        <nav className="footer-links" aria-label="Footer navigation">
          <Link to="/docs/$" params={{ _splat: "quickstart" }}><GuideIcon />Quickstart</Link>
          <a href={REPOSITORY} rel="noreferrer" target="_blank"><Github />GitHub</a>
          <a href="https://discord.gg/Z74jwRxz4k" rel="noreferrer" target="_blank"><Discord />Discord</a>
          <ThemeToggle />
        </nav>
      </div>
    </footer>
  )
}

export const SiteShell = ({ children, pathname }: { readonly children: ReactNode; readonly pathname: string }): ReactElement => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const headerRef = useRef<HTMLElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const docs = pathname.startsWith("/docs")
  const closeMobileMenu = (): void => setMobileMenuOpen(false)

  useEffect(() => {
    if (!mobileMenuOpen) return

    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !headerRef.current?.contains(event.target)) setMobileMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return
      setMobileMenuOpen(false)
      menuButtonRef.current?.focus()
    }
    const closeAtDesktop = (): void => {
      if (window.innerWidth > 800) setMobileMenuOpen(false)
    }

    document.addEventListener("pointerdown", closeOutside)
    document.addEventListener("keydown", closeOnEscape)
    window.addEventListener("resize", closeAtDesktop)
    return () => {
      document.removeEventListener("pointerdown", closeOutside)
      document.removeEventListener("keydown", closeOnEscape)
      window.removeEventListener("resize", closeAtDesktop)
    }
  }, [mobileMenuOpen])

  return <>
    <header className="site-header" ref={headerRef}>
      <nav className="nav-inner" aria-label="Main navigation">
        <div className="nav-brand-group">
          <Link className="brand" to="/" aria-label="Tardigrade home"><Mark /><span>Tardigrade</span></Link>
          <Link className="guide-link" to="/docs" aria-current={docs ? "page" : undefined}>Docs</Link>
        </div>
        <div className="nav-actions">
          <a className="github-link" href={REPOSITORY} aria-label="Tardigrade on GitHub" rel="noreferrer" target="_blank"><Github /></a>
          <a className="discord-link" href="https://discord.gg/Z74jwRxz4k" aria-label="Tardigrade on Discord" rel="noreferrer" target="_blank"><Discord /></a>
          <div className="header-theme-toggle"><ThemeToggle /></div>
          <button className="mobile-menu-trigger" type="button" aria-controls="mobile-navigation" aria-expanded={mobileMenuOpen} ref={menuButtonRef} onClick={() => setMobileMenuOpen((open) => !open)}>
            <MenuIcon />
            <span>Menu</span>
          </button>
        </div>
      </nav>
      <div className="mobile-nav-panel" data-open={mobileMenuOpen} id="mobile-navigation" aria-hidden={!mobileMenuOpen} inert={!mobileMenuOpen ? true : undefined}>
        <nav className="mobile-nav-panel-inner" aria-label="Mobile navigation">
          <div className="mobile-nav-primary">
            <div className="mobile-nav-sections">
              <Link to="/docs" aria-current={docs ? "page" : undefined} onClick={closeMobileMenu}>Docs</Link>
            </div>
          </div>
          <div className="mobile-nav-resources">
            <a href={REPOSITORY} aria-label="Tardigrade on GitHub" rel="noreferrer" target="_blank" onClick={closeMobileMenu}><Github /></a>
            <a href="https://discord.gg/Z74jwRxz4k" aria-label="Tardigrade on Discord" rel="noreferrer" target="_blank" onClick={closeMobileMenu}><Discord /></a>
            <ThemeToggle />
          </div>
        </nav>
      </div>
    </header>

    {children}
    <SiteFooter />
  </>
}

export const LandingPage = (): ReactElement => (
  <main>
      <section className="hero">
        <PuzzlePiece />
        <div className="hero-inner">
          <div className="hero-copy">
            <h1><span>Build stateful agents</span><span>from simple components.</span></h1>
            <p>Tardigrade is a TypeScript framework for building modular agents around an immutable event log. Built on Effect TS.</p>
            <div className="hero-cta-stack">
              <div className="hero-actions">
                <CopyPromptButton />
                <a className="button button-secondary" href={REPOSITORY} rel="noreferrer" target="_blank"><Github />View GitHub</a>
              </div>
              <InstallCommand />
            </div>
          </div>
          <CodeExample />
        </div>
      </section>
      <HowItWorks />
      <Durability />
      <Scalability />
      <Observability />
      <Deployments />
  </main>
)
