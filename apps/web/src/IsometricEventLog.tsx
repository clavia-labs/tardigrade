import type { ReactElement } from "react"
import { PostalStamp } from "./PostalStamp"

type Point = readonly [number, number]

type EventSpec = {
  readonly sequence: string
  readonly name: string
  readonly value: string
  readonly x: number
  readonly y: number
  readonly z: number
}

type Cuboid = EventSpec & {
  readonly points: ReadonlyArray<Point>
  readonly top: string
  readonly right: string
  readonly left: string
  readonly anchor: Point
  readonly depth: number
}

const UNIT = 4
const WIDTH = 18
const HEIGHT = 1.4
const DEPTH = 5
const LABEL_GAP = 64
const LABEL_WIDTH = 280
const SHOW_LOG_STRUCTURE = false
const STAMP_HEIGHT = 44
const STAMP_GAP = 8
const STAMP_LABEL_OFFSET = 20

const project = (x: number, y: number, z: number): Point => [
  (x - z) * 2 * UNIT,
  (x + z) * UNIT - y * 2 * UNIT
]

const path = (points: ReadonlyArray<Point>): string => `${points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`).join("")}Z`

const cuboid = (event: EventSpec): Cuboid => {
  const x1 = event.x + WIDTH
  const y1 = event.y + HEIGHT
  const z1 = event.z + DEPTH
  const vertices = {
    bbr: project(x1, event.y, event.z),
    bfr: project(x1, event.y, z1),
    bfl: project(event.x, event.y, z1),
    tbl: project(event.x, y1, event.z),
    tbr: project(x1, y1, event.z),
    tfr: project(x1, y1, z1),
    tfl: project(event.x, y1, z1)
  }

  return {
    ...event,
    points: Object.values(vertices),
    top: path([vertices.tbl, vertices.tbr, vertices.tfr, vertices.tfl]),
    right: path([vertices.bbr, vertices.bfr, vertices.tfr, vertices.tbr]),
    left: path([vertices.bfl, vertices.bfr, vertices.tfr, vertices.tfl]),
    anchor: vertices.tfl,
    depth: event.x + WIDTH / 2 + event.y + HEIGHT / 2 + event.z + DEPTH / 2
  }
}

const eventSpecs: ReadonlyArray<EventSpec> = [
  { sequence: "01", name: "MessageReceived", value: "Audit the deployment.", x: 0, y: 36, z: 0 },
  { sequence: "02", name: "ToolCalled", value: "git_log({ limit: 3 })", x: 0.4, y: 27, z: 0.2 },
  { sequence: "03", name: "ToolReturned", value: "3 commits returned", x: 0.8, y: 18, z: 0.4 },
  { sequence: "04", name: "CompactionCompleted", value: "18k → 8k tokens", x: 1.2, y: 9, z: 0.6 },
  { sequence: "05", name: "TurnCompleted", value: "Rate limiting verified.", x: 1.6, y: 0, z: 0.8 }
]

const eventBlocks = eventSpecs.map(cuboid)
const blocks = [...eventBlocks].sort((a, b) => a.depth - b.depth)
const rows = SHOW_LOG_STRUCTURE ? blocks : eventBlocks

const envelope = (() => {
  const x0 = -2
  const y0 = -2
  const z0 = -2
  const x1 = 22
  const y1 = 40
  const z1 = 8
  const vertices = {
    bbl: project(x0, y0, z0),
    bbr: project(x1, y0, z0),
    bfr: project(x1, y0, z1),
    bfl: project(x0, y0, z1),
    tbl: project(x0, y1, z0),
    tbr: project(x1, y1, z0),
    tfr: project(x1, y1, z1),
    tfl: project(x0, y1, z1)
  }
  return {
    points: Object.values(vertices),
    top: path([vertices.tbl, vertices.tbr, vertices.tfr, vertices.tfl]),
    right: path([vertices.bbr, vertices.bfr, vertices.tfr, vertices.tbr]),
    left: path([vertices.bfl, vertices.bfr, vertices.tfr, vertices.tfl]),
    visible: path([vertices.tbl, vertices.tbr, vertices.bbr, vertices.bfr, vertices.bfl, vertices.tfl]),
    joints: [
      `M${vertices.tbr[0]} ${vertices.tbr[1]}L${vertices.tfr[0]} ${vertices.tfr[1]}L${vertices.tfl[0]} ${vertices.tfl[1]}`,
      `M${vertices.tfr[0]} ${vertices.tfr[1]}L${vertices.bfr[0]} ${vertices.bfr[1]}`
    ],
    hidden: [
      `M${vertices.bbl[0]} ${vertices.bbl[1]}L${vertices.bbr[0]} ${vertices.bbr[1]}`,
      `M${vertices.bbl[0]} ${vertices.bbl[1]}L${vertices.bfl[0]} ${vertices.bfl[1]}`,
      `M${vertices.bbl[0]} ${vertices.bbl[1]}L${vertices.tbl[0]} ${vertices.tbl[1]}`
    ]
  }
})()

const bounds = (() => {
  if (!SHOW_LOG_STRUCTURE) {
    return {
      x: 0,
      y: 0,
      width: LABEL_WIDTH,
      height: eventSpecs.length * (STAMP_HEIGHT + STAMP_GAP) - STAMP_GAP
    }
  }

  const geometry = SHOW_LOG_STRUCTURE ? [...blocks.flatMap((block) => block.points), ...envelope.points] : []
  const labels = blocks.flatMap((block) => {
    const labelRight = block.anchor[0] - LABEL_GAP
    return [[labelRight - LABEL_WIDTH - 10, block.anchor[1] - 24], [labelRight, block.anchor[1] + 31]] as const
  })
  const points = [...geometry, ...labels]
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const padding = 10
  const x = Math.min(...xs) - padding
  const y = Math.min(...ys) - padding
  return {
    x,
    y,
    width: Math.max(...xs) - x + padding,
    height: Math.max(...ys) - y + padding
  }
})()

const Face = ({ d, tint }: { readonly d: string; readonly tint: number }): ReactElement => (
  <>
    <path d={d} fill="var(--surface)" />
    <path d={d} fill="currentColor" opacity={tint} />
  </>
)

type IsometricEventLogProps = {
  readonly derivedSequence: string | undefined
  readonly onSelect: (sequence: string) => void
  readonly selectedSequence: string | null
}

export const IsometricEventLog = ({ derivedSequence, onSelect, selectedSequence }: IsometricEventLogProps): ReactElement => (
  <svg
    className="isometric-log"
    viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`}
    role="group"
    aria-label="Agent event log"
    aria-describedby="isometric-log-description"
    shapeRendering="geometricPrecision"
  >
    <desc id="isometric-log-description">Five immutable events. Select an event to inspect the component projection it activates.</desc>
    {SHOW_LOG_STRUCTURE && (
      <g className="actor-envelope-surfaces" aria-hidden="true">
        <path d={envelope.top} />
        <path d={envelope.right} />
        <path d={envelope.left} />
      </g>
    )}
    {rows.map((block, index) => {
      const labelRight = block.anchor[0] - LABEL_GAP
      const labelX = SHOW_LOG_STRUCTURE ? labelRight - LABEL_WIDTH : 10
      const labelY = SHOW_LOG_STRUCTURE ? block.anchor[1] : index * (STAMP_HEIGHT + STAMP_GAP) + STAMP_LABEL_OFFSET
      const tint = 0.05 + index * 0.015
      const selected = selectedSequence === block.sequence
      const derived = derivedSequence === block.sequence
      const dimmed = selectedSequence !== null && !selected && !derived
      return (
        <g
          className={`event-log-row${selected ? " is-selected" : ""}${derived ? " is-derived" : ""}${dimmed ? " is-dimmed" : ""}`}
          data-event-sequence={block.sequence}
          role="button"
          aria-label={`${block.name}: ${block.value}`}
          tabIndex={0}
          aria-pressed={selected}
          key={block.sequence}
          onClick={() => onSelect(block.sequence)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            onSelect(block.sequence)
          }}
        >
          {SHOW_LOG_STRUCTURE && (
            <>
              <Face d={block.top} tint={tint} />
              <Face d={block.right} tint={tint + 0.05} />
              <Face d={block.left} tint={tint + 0.09} />
              <path className="isometric-block-outline" d={block.top} />
              <path className="isometric-block-outline" d={block.right} />
              <path className="isometric-block-outline" d={block.left} />
              <path className="event-callout" d={`M${block.anchor[0]} ${block.anchor[1]}H${labelRight + 10}`} />
            </>
          )}
          <PostalStamp className="event-stamp" id={`event-stamp-${block.sequence}`} x={labelX - 10} y={labelY - STAMP_LABEL_OFFSET} width={LABEL_WIDTH} height={STAMP_HEIGHT} />
          <text className="event-sequence" x={labelX} y={labelY - 2}>{block.sequence}</text>
          <text className="event-name" x={labelX + 28} y={labelY - 2}>{block.name}</text>
          <text className="event-value" x={labelX + 28} y={labelY + 12}>{block.value}</text>
        </g>
      )
    })}
    {SHOW_LOG_STRUCTURE && (
      <g className="actor-envelope-edges" aria-hidden="true">
        <path d={envelope.visible} />
        {envelope.joints.map((edge) => <path d={edge} key={edge} />)}
        {envelope.hidden.map((edge) => <path className="actor-envelope-hidden" d={edge} key={edge} />)}
      </g>
    )}
  </svg>
)
