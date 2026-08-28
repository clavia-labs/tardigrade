import { useEffect, useRef, useState, type ReactElement } from "react"
import { ComponentBridge } from "./ComponentBridge"
import { FlowOverlay } from "./FlowOverlay"
import { IsometricEventLog } from "./IsometricEventLog"
import { WorldGlobe } from "./WorldGlobe"

const REPOSITORY = "https://github.com/clavia-labs/tardigrade"
const SHOW_HARNESS_CONTROLS = import.meta.env.VITE_SHOW_HARNESS_CONTROLS === "true"
const INIT_COMMAND = "bunx tardie init"
const STARTER_PROMPT = `Build a durable TypeScript agent with Tardigrade. Start from the quickstart at ${REPOSITORY}#quickstart and use the fewest components needed for the task.`

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

const ConsoleIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeLinecap="square" strokeWidth="1.6" d="M3.5 5.5h17v13h-17zM7 10l2 2-2 2m5 0h4" />
  </svg>
)

const CopyIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeWidth="1.8" d="M9 8h9v11H9zM6 16H5V5h9v1" />
  </svg>
)

const CheckIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeLinecap="square" strokeLinejoin="miter" strokeWidth="1.8" d="m5 12.5 4.2 4.2L19 7" />
  </svg>
)

const ConceptArrow = (): ReactElement => (
  <svg className="concept-arrow" viewBox="0 0 96 24" aria-hidden="true">
    <path d="M2 12H92" />
    <path d="M84 5 92 12 84 19" />
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

const CommandLine = ({ command, label }: { readonly command: string; readonly label: string }): ReactElement => {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const reset = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(reset)
  }, [copied])

  const copyCommand = async (): Promise<void> => {
    await navigator.clipboard.writeText(command)
    setCopied(true)
  }

  return (
    <div className="install-command" aria-label={label}>
      <span aria-hidden="true">$</span>
      <code>{command}</code>
      <button type="button" aria-label={copied ? "Command copied" : "Copy command"} title={copied ? "Copied" : "Copy command"} onClick={() => void copyCommand()}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  )
}

const InstallCommand = (): ReactElement => <CommandLine command={INIT_COMMAND} label="Install Tardigrade" />

const syntaxPattern = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:import|from|const|as|export|default|type|return|async|await)\b|\b(?:true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b|\b(?:actor|infer|system|budget|codeMode|compaction|filesPackage|fetchPackage|agentsPackage|workspacePackage|outputValidateOnce|budgetAuthority|caller)\b)/g

const syntaxTone = (value: string): string => {
  if (value.startsWith("//") || value.startsWith("/*")) return "comment"
  if (/^["'`]/.test(value)) return "string"
  if (/^\d/.test(value)) return "number"
  if (/^(?:true|false|null|undefined)$/.test(value)) return "literal"
  if (/^(?:import|from|const|as|export|default|type|return|async|await)$/.test(value)) return "keyword"
  return "function"
}

const HighlightedCode = ({ code }: { readonly code: string }): ReactElement => {
  const parts = code.split(syntaxPattern)
  return <>{parts.map((part, index) => index % 2 === 1 ? <span className={`syntax-${syntaxTone(part)}`} key={`${index}-${part}`}>{part}</span> : part)}</>
}

const ActorCopyButton = (): ReactElement => {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const reset = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(reset)
  }, [copied])

  const copyExample = async (event: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    const example = event.currentTarget.closest(".guide-actor-example")
    const code = Array.from(example?.querySelectorAll("pre") ?? [])
      .map((block) => block.textContent ?? "")
      .join("\n\n")
    await navigator.clipboard.writeText(code)
    setCopied(true)
  }

  return (
    <button className="guide-code-copy" type="button" aria-label={copied ? "Actor copied" : "Copy actor"} onClick={(event) => void copyExample(event)}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  )
}

const CodeSnippet = ({ code, label }: { readonly code: string; readonly label: string }): ReactElement => {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const reset = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(reset)
  }, [copied])

  const copyCode = async (): Promise<void> => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
  }

  return (
    <div className="concept-code">
      <pre><code><HighlightedCode code={code} /></code></pre>
      <button type="button" aria-label={copied ? `${label} copied` : `Copy ${label}`} onClick={() => void copyCode()}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
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
  { tokens: [token("    system", "purple"), token("("), token("\"Research the given question and cite the sources that support your answer.\"", "blue"), token("),")] }
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
    if (section === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return

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

    observer.observe(section)
    return () => {
      observer.disconnect()
      cancelAutoplay()
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
          <p>Every event is written to a durable log. Each component is a pure function over the log. <span className="function-signature">f(log)</span> derives the next effect, and each result returns to the log until the turn is complete.</p>
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
        <h2>Extremely durable.</h2>
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

const TrajectoryField = (): ReactElement => (
  <svg className="trajectory-field" viewBox="0 0 260 300" role="img" aria-labelledby="trajectory-title trajectory-description">
    <title id="trajectory-title">Agent trajectories</title>
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
            {observedEvents.map(([sequence, lane, event, detail]) => (
              <li data-lane={lane} key={sequence}>
                <span>{sequence}</span>
                <em>{lane}</em>
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

type GuideRoute = "guide" | "concepts" | "cli" | "rlm"

const GuideSidebar = ({ current }: { readonly current: GuideRoute }): ReactElement => (
  <aside className="guide-sidebar">
    <span>Introduction</span>
    <a href="/guide" aria-current={current === "guide" ? "page" : undefined}>Getting Started</a>
    <a href="/concepts" aria-current={current === "concepts" ? "page" : undefined}>Concepts</a>
    <a href="/cli" aria-current={current === "cli" ? "page" : undefined}>CLI Reference</a>
    <span className="guide-sidebar-section">Examples</span>
    <a href="/examples/rlm" aria-current={current === "rlm" ? "page" : undefined}>RLM</a>
    <span className="guide-coming-soon">Work in progress...</span>
  </aside>
)

const GuidePage = (): ReactElement => (
  <main className="guide-page">
    <div className="guide-shell">
      <GuideSidebar current="guide" />
      <article className="guide-article">
        <h1>Getting Started</h1>
        <p className="guide-intro">Build and run your first durable agent.</p>
        <div className="guide-divider" />
        <p><strong>Tardigrade</strong> is a TypeScript framework for building modular agents around a durable event log. Components read the log, derive work, and append the results.</p>
        <h2>Initialize a project</h2>
        <p>Run the initializer in a new or existing TypeScript project.</p>
        <div className="guide-command"><InstallCommand /></div>
        <h3>What gets created</h3>
        <p>The initializer creates a small project that can run locally or on your own infrastructure.</p>
        <div className="guide-scaffold" aria-label="Initialized project structure">
          <strong>my-agent/</strong>
          <ul>
            <li><code>actor.ts</code><span /><p>Actor, model, and components</p></li>
            <li><code>worker.ts</code><span /><p>Worker runtime entry</p></li>
            <li><code>wrangler.jsonc</code><span /><p>Worker and Durable Object config</p></li>
            <li><code>celld.jsonc</code><span /><p>Self-hosted Celld config</p></li>
            <li><code>package.json</code><span /><p>Dependencies and module metadata</p></li>
          </ul>
        </div>
        <h2>Define an actor</h2>
        <h3 className="guide-example-title">Hello world agent</h3>
        <p>If you have built a tool-calling agent before, the pieces will feel familiar: instructions, a model, and tools. Tardigrade gives those pieces a durable home inside an actor.</p>
        <div className="guide-actor-example">
          <ActorCopyButton />
          <div className="guide-code-row" data-tone="setup">
            <pre><code>{`import type { AgentComponent } from "tardie"
import { actor, agentMessageMethod, infer,
  nativeOutput, system } from "tardie"`}</code></pre>
            <aside><strong>Familiar pieces</strong><p>The model loop, instructions, and fixed tools remain explicit.</p></aside>
          </div>
          <div className="guide-code-row" data-tone="tool">
            <pre><code>{`const weather: AgentComponent = {
  name: "weather",
  derive: () => ({
    view: {
      system: ["Use weather for current conditions."],
      tools: [{
        spec: {
          name: "get_weather",
          description: "Get weather for a city",
          inputSchema: { type: "object" }
        },
        serve: (call, _log, answer) => [
          answer({ city: call.arguments, temperature: 21 })
        ]
      }],
      context: [],
      output: []
    },
    transitions: []
  })
}`}</code></pre>
            <aside><strong>weather component</strong><p><code>derive</code> is pure. It contributes a tool and the handler that serves it.</p></aside>
          </div>
          <div className="guide-code-row" data-tone="name">
            <pre><code>{`export default actor({
  name: "weather-agent",`}</code></pre>
            <aside><strong>name</strong><p>The stable identity used by builds, deployments, and stored logs.</p></aside>
          </div>
          <div className="guide-code-row" data-tone="methods">
            <pre><code>{`  methods: { message: agentMessageMethod },`}</code></pre>
            <aside><strong>methods</strong><p>The typed calls clients can make. This actor accepts a message.</p></aside>
          </div>
          <div className="guide-code-row" data-tone="components">
            <pre><code>{`  components: [infer([
    system("Answer questions about the weather."),
    weather,
    nativeOutput
  ], { provider: "openai", default_model: "gpt-5.2" })]
})`}</code></pre>
            <aside><strong>components</strong><p>Pure functions over the log that compose instructions, tools, output, and policy.</p></aside>
          </div>
        </div>
        <h2>Run locally</h2>
        <p>Run the development host from the actor directory. It builds <code>actor.ts</code>, starts the local API, and opens Voyager.</p>
        <div className="guide-command"><CommandLine command="tdg dev" label="Run the actor locally" /></div>
        <div className="guide-scaffold guide-runtime-store" aria-label="Local Tardigrade state">
          <strong>.tardigrade/</strong>
          <ul>
            <li><code>actor.sqlite</code><span /><p>Durable event logs for every thread</p></li>
            <li><code>models.json</code><span /><p>Validated model catalog cache</p></li>
          </ul>
        </div>
        <h2>Send a message</h2>
        <p>Keep the development host running. From another terminal, call the actor's <code>message</code> method and wait for its durable result.</p>
        <div className="guide-command"><CommandLine command={'tdg call message \'{"text":"What is the weather in Singapore?"}\''} label="Send a message" /></div>
        <p className="guide-followup">The command prints the answer and a direct Voyager URL for the new trace.</p>
        <h2>Test the actor</h2>
        <p>Validate the actor's declared methods and component handlers before deployment.</p>
        <div className="guide-command"><CommandLine command="tdg lint actor.ts" label="Validate the actor" /></div>
        <h2>Deploy</h2>
        <p>Add the same provider credential to your chosen platform, then deploy with one of the generated configurations.</p>
        <div className="guide-deploy-commands">
          <div><span>Cloudflare</span><CommandLine command="bunx wrangler deploy" label="Deploy to Cloudflare" /></div>
          <div><span>Celld</span><CommandLine command="celld deploy --config celld.jsonc" label="Deploy with Celld" /></div>
        </div>
      </article>
    </div>
  </main>
)

const cliCommands = [
  ["tdg init <name>", "Create an actor and configure its first model provider"],
  ["tdg setup", "Add provider connections and choose the default model"],
  ["tdg lint <entry>", "Validate an actor before building or deploying"],
  ["tdg build <entry>", "Build and validate an actor artifact"],
  ["tdg dev", "Build actor.ts and serve the local API and Voyager"],
  ["tdg methods", "List the actor's methods and schemas"],
  ["tdg call <method> <input>", "Call a method with JSON input and wait for its result"],
  ["tdg ls", "List threads"],
  ["tdg events <thread>", "Print a thread's event log"],
  ["tdg providers", "List provider protocols and setup requirements"],
  ["tdg models", "Search the model catalog"]
] as const

const CliPage = (): ReactElement => (
  <main className="guide-page">
    <div className="guide-shell">
      <GuideSidebar current="cli" />
      <article className="guide-article cli-article">
        <h1>CLI Reference</h1>
        <p className="guide-intro">Build, run, and inspect Tardigrade actors.</p>
        <div className="guide-divider" />
        <h2>Install</h2>
        <div className="guide-command"><CommandLine command="bun add -g tardie" label="Install the Tardigrade CLI" /></div>
        <p className="cli-install-note">Use <code>bunx tardie &lt;command&gt;</code> to run a command without installing it.</p>
        <h2>Commands</h2>
        <div className="cli-command-list">
          {cliCommands.map(([command, description]) => (
            <div className="cli-command-row" key={command}>
              <code>{command}</code>
              <p>{description}</p>
            </div>
          ))}
        </div>
        <p className="cli-reference-note">Use <code>--json</code> for machine-readable output. Remote commands accept <code>--url</code> and <code>--token</code>. Run <code>tdg &lt;command&gt; --help</code> for every option.</p>
      </article>
    </div>
  </main>
)

const rlmSource = `import {
  actor, agentMethods, agentsPackage, budget,
  budgetAuthority, caller, codeMode, compaction,
  fetchPackage, filesPackage, infer,
  outputValidateOnce, system, workspacePackage
} from "tardie"

const instructions = system(
  "Investigate with code and delegate independent work."
)

const model = {
  provider: "openrouter",
  default_model: "anthropic/claude-sonnet-4.6"
} as const

const rlm = actor({
  name: "researcher",
  methods: agentMethods,
  components: [
    infer([
      instructions,
      budget([
        codeMode([
          filesPackage(),
          fetchPackage(),
          agentsPackage(),
          workspacePackage()
        ])
      ], { authority: caller() }),
      compaction(),
      outputValidateOnce
    ], model),
    budgetAuthority()
  ]
})
`

const RlmExamplePage = (): ReactElement => (
  <main className="guide-page">
    <div className="guide-shell">
      <GuideSidebar current="rlm" />
      <article className="guide-article example-article">
        <h1>Recursive Language Model</h1>
        <p className="guide-intro">A durable RLM built from Tardigrade components.</p>
        <div className="guide-divider" />
        <h2>What is an RLM?</h2>
        <p>An RLM puts long context inside a code environment. The model inspects and partitions that context, calls models over smaller pieces, and combines their work into one answer.</p>
        <div className="rlm-reading">
          <a href="https://alexzhang13.github.io/blog/2025/rlm/" rel="noreferrer" target="_blank">Original write-up</a>
          <a href="https://arxiv.org/abs/2512.24601" rel="noreferrer" target="_blank">Read the paper</a>
        </div>
        <div className="rlm-diagram" role="img" aria-label="A long context enters a code environment that makes recursive model calls and returns a final answer">
          <div className="rlm-context-card">
            <span>context as data</span>
            <div aria-hidden="true"><i /><i /><i /><i /><i /></div>
            <code>context[0..n]</code>
          </div>
          <div className="rlm-diagram-arrow" aria-hidden="true" />
          <div className="rlm-program-card">
            <span>code environment</span>
            <code>inspect(context)</code>
            <code>partition(context)</code>
            <strong>recursive model calls</strong>
            <div className="rlm-subcalls" aria-hidden="true"><i>LM 01</i><i>LM 02</i><i>LM 03</i></div>
          </div>
          <div className="rlm-diagram-arrow" aria-hidden="true" />
          <div className="rlm-answer-card">
            <span>result</span>
            <strong>final answer</strong>
          </div>
        </div>
        <h2>Build it with Tardigrade</h2>
        <p>Code mode provides the environment. Packages expose files, fetch, workspace storage, and child agents. Budgets and compaction keep the recursive work bounded.</p>
        <div className="example-source-heading">
          <span>README.md / Compose an agent</span>
          <a href={`${REPOSITORY}#compose-an-agent`} rel="noreferrer" target="_blank"><Github />View on GitHub</a>
        </div>
        <CodeSnippet code={rlmSource} label="RLM implementation" />
        <h2>How it is assembled</h2>
        <div className="rlm-parts">
          <div><code>codeMode</code><p>Lets the model act by writing JavaScript.</p></div>
          <div><code>agentsPackage</code><p>Lets that code spawn durable child agents.</p></div>
          <div><code>workspacePackage</code><p>Stores large values outside the model context.</p></div>
          <div><code>budget + compaction</code><p>Bounds delegated work and the context sent to the model.</p></div>
        </div>
        <h2>Start from the quickstart</h2>
        <p>Initialize a project, then replace its actor assembly with this RLM.</p>
        <div className="guide-command"><CommandLine command="tdg init researcher" label="Initialize the RLM project" /></div>
      </article>
    </div>
  </main>
)

const ConceptsPage = (): ReactElement => (
  <main className="guide-page">
    <div className="guide-shell">
      <GuideSidebar current="concepts" />
      <article className="guide-article concepts-article">
        <h1>Core Concepts</h1>
        <p className="guide-intro">Thinking in Tardigrade.</p>
        <div className="guide-divider" />

        <section className="concept-section concept-section-actor">
          <div className="concept-copy">
            <h2>Actor</h2>
            <p>An actor is one durable event log and the components that interpret it. Methods append facts to the log. Components read those facts and decide what happens next.</p>
          </div>
          <div className="concept-interface">
            <span>interface</span>
            <pre>{`actor({
  name: string,
  methods: ActorMethods,
  components: Component[]
})`}</pre>
          </div>
          <div className="actor-concept-illustration" aria-label="An actor definition mounted beside its durable event log">
            <div className="actor-concept-source">
              <span>actor.ts</span>
              <CodeSnippet label="actor example" code={`actor({
  name: "researcher",
  methods: { message },
  components: [infer]
})`} />
            </div>
            <div className="actor-concept-link" aria-hidden="true">
              <svg viewBox="0 0 80 48">
                <defs><marker id="actor-link-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 7 3.5 0 7Z" /></marker></defs>
                <path d="M3 24H76" markerEnd="url(#actor-link-arrow)" />
              </svg>
              <span>mounts</span>
            </div>
            <div className="actor-concept-store-wrap">
              <span>event store</span>
              <div className="actor-concept-store">
                <header><code>thread / audit-42</code></header>
                <ol>
                  <li data-tone="message"><span>01</span><code>MessageReceived</code></li>
                  <li data-tone="tool"><span>02</span><code>ToolCalled</code></li>
                  <li data-tone="return"><span>03</span><code>ToolReturned</code></li>
                  <li data-tone="done"><span>04</span><code>TurnCompleted</code></li>
                </ol>
              </div>
            </div>
          </div>
        </section>

        <section className="concept-section concept-section-methods">
          <div className="concept-copy">
            <h2>Methods</h2>
            <p>Methods are the actor's typed public API. A method defines the input event and how callers read pending, completed, or failed state from the log.</p>
          </div>
          <div className="concept-interface">
            <span>interface</span>
            <pre>{`actorMethod({
  input, output, timeoutMs?,
  event(call): Event,
  state(log, id): MethodState
})`}</pre>
          </div>
          <div className="methods-concept-illustration" aria-label="The world makes a typed method call that appends an event to the actor log">
            <div className="methods-world">
              <span>world</span>
              <WorldGlobe />
            </div>
            <div className="methods-arrow"><ConceptArrow /></div>
            <div className="typed-method-call">
              <span>typed method</span>
              <code>{`message({
  text: "Find the evidence"
})`}</code>
            </div>
            <div className="methods-arrow"><ConceptArrow /></div>
            <div className="actor-concept-store-wrap methods-event-store">
              <span>event log</span>
              <div className="actor-concept-store">
                <header><code>thread / audit-42</code></header>
                <ol>
                  <li data-tone="message"><span>01</span><code>MessageReceived</code><small>Find the evidence</small></li>
                </ol>
              </div>
            </div>
          </div>
        </section>

        <section className="concept-section concept-section-components">
          <div className="concept-copy">
            <h2>Components</h2>
            <p>A component is a pure function over the complete event log. It returns the view its parent consumes and the transitions that are due.</p>
            <p>The log is the input. Components do not own hidden mutable state, so the same log always produces the same plan.</p>
            <div className="concept-formula"><code>f(log)</code><span>→</span><code>{`{ view, transitions }`}</code></div>
          </div>
          <div className="concept-interface">
            <span>interface</span>
            <pre>{`component({
  name: string,
  keys?: KeyFragment,
  derive(log): { view, transitions }
})`}</pre>
          </div>
          <div className="compaction-example-copy">
            <h3>Example: compaction</h3>
            <p>At 104k tokens, the log has crossed the 80% threshold of a 128k window. Compaction keeps a 64k tail in the view and derives a summarization transition. When that work completes, it appends <code>CompactionCompleted</code> to the same log.</p>
          </div>
          <div className="compaction-flow" aria-label="Compaction derives a context view and a transition from the event log">
            <div className="compaction-log">
              <span>event log</span>
              <div className="compaction-log-stack" aria-hidden="true">
                <i /><i /><i /><i /><i />
              </div>
              <strong>104k tokens</strong>
            </div>
            <div className="compaction-flow-arrow" aria-hidden="true">→</div>
            <div className="compaction-derive">
              <span>component</span>
              <code>compaction.derive(log)</code>
              <dl>
                <div><dt>window</dt><dd>128k</dd></div>
                <div><dt>fire</dt><dd>80% · 102k</dd></div>
                <div><dt>keep</dt><dd>50% · 64k</dd></div>
              </dl>
            </div>
            <div className="compaction-flow-arrow" aria-hidden="true">→</div>
            <div className="compaction-results">
              <div>
                <span>view</span>
                <strong>Context policy</strong>
                <p>Render a 64k-token tail after the latest checkpoint.</p>
              </div>
              <div>
                <span>transition</span>
                <strong>Summarization due</strong>
                <p>Summarize the older history and append <code>CompactionCompleted</code>.</p>
              </div>
            </div>
          </div>
        </section>

      </article>
    </div>
  </main>
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

const ConsolePage = (): ReactElement => (
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
  const footerRef = useRef<HTMLElement | null>(null)
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    const footer = footerRef.current
    if (footer === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return
      setEntered(true)
      observer.disconnect()
    }, { threshold: 0.55 })
    observer.observe(footer)
    return () => observer.disconnect()
  }, [])

  return (
    <footer className={`site-footer${entered ? " is-visible" : ""}`} ref={footerRef}>
      <div className="footer-inner">
        <a className="footer-brand" href="/" aria-label="Tardigrade home"><Mark /><span>Tardigrade</span></a>
        <nav className="footer-links" aria-label="Footer navigation">
          <a href="/guide"><GuideIcon />Guide</a>
          <a href="/console"><ConsoleIcon />Console</a>
          <a href={REPOSITORY} rel="noreferrer" target="_blank"><Github />GitHub</a>
          <a href="https://discord.gg/Z74jwRxz4k" rel="noreferrer" target="_blank"><Discord />Discord</a>
        </nav>
      </div>
    </footer>
  )
}

export const App = (): ReactElement => {
  const guide = window.location.pathname === "/guide" || window.location.pathname.startsWith("/guide/")
  const cli = window.location.pathname === "/cli" || window.location.pathname.startsWith("/cli/")
  const concepts = window.location.pathname === "/concepts" || window.location.pathname.startsWith("/concepts/")
  const examples = window.location.pathname === "/examples" || window.location.pathname.startsWith("/examples/")
  const consolePage = window.location.pathname === "/console" || window.location.pathname.startsWith("/console/")

  return <>
    <header className="site-header">
      <nav className="nav-inner" aria-label="Main navigation">
        <div className="nav-brand-group">
          <a className="brand" href="/" aria-label="Tardigrade home"><Mark /><span>Tardigrade</span></a>
          <a className="guide-link" href="/guide" aria-current={guide ? "page" : undefined}>Guide</a>
          <a className="guide-link" href="/concepts" aria-current={concepts ? "page" : undefined}>Concepts</a>
          <a className="guide-link" href="/cli" aria-current={cli ? "page" : undefined}>CLI</a>
          <a className="guide-link" href="/examples/rlm" aria-current={examples ? "page" : undefined}>Examples</a>
        </div>
        <div className="nav-links">
          <a href={`${REPOSITORY}/blob/main/docs/quickstart.md`} rel="noreferrer" target="_blank">Guide</a>
          <a href={`${REPOSITORY}/tree/main/docs`} rel="noreferrer" target="_blank">Reference</a>
          <a href={`${REPOSITORY}/blob/main/docs/how-to/cli.md`} rel="noreferrer" target="_blank">CLI</a>
          <a href={`${REPOSITORY}/tree/main/apps/voyager`} rel="noreferrer" target="_blank">Voyager</a>
        </div>
        <div className="nav-actions">
          <a className="docs-link" href={`${REPOSITORY}/tree/main/docs`} rel="noreferrer" target="_blank">Docs</a>
          <a className="console-link" href="/console" aria-current={consolePage ? "page" : undefined}>Console</a>
          <a className="github-link" href={REPOSITORY} aria-label="Tardigrade on GitHub" rel="noreferrer" target="_blank"><Github /></a>
        </div>
      </nav>
    </header>

    {guide ? <GuidePage /> : concepts ? <ConceptsPage /> : cli ? <CliPage /> : examples ? <RlmExamplePage /> : consolePage ? <ConsolePage /> : <main>
      <section className="hero">
        <PuzzlePiece />
        <div className="hero-inner">
          <div className="hero-copy">
            <h1><span>Build complex agents</span><span>from simple components.</span></h1>
            <p>Tardigrade is a TypeScript framework for building modular agents around a durable event log.</p>
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
      <Observability />
      <Deployments />
      <SiteFooter />
    </main>}
  </>
}
