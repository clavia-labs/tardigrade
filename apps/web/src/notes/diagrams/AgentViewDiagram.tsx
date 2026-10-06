import { Bird, Cpu, Database, HardDrive, Question } from "@phosphor-icons/react"
import { useId, type ReactElement } from "react"
import tardie from "../../../../../assets/mascot/tardie-curious.svg"

const label = "The agent writes buy milk to /notes/todo.md, later reads the same path, and gets buy milk back. It sees a tree of paths; below a dashed line, a filesystem, an in-memory store, SQLite, a carrier pigeon, or something else can hold that tree."

// Workspace draws the tree the agent sees, with todo.md holding the text written to it.
const Workspace = ({ x, y }: { readonly x: number; readonly y: number }): ReactElement => (
  <g transform={`translate(${x} ${y})`}>
    <path className="agent-view-folder" d="M0-20h5l2 2h7v10H0Z" />
    <text className="agent-view-kind" x="22" y="-10">Workspace</text>
    <rect className="agent-view-box" width="240" height="168" />
    <rect className="agent-view-hit" x="70" y="51" width="74" height="24" />
    <g className="agent-view-tree">
      <path d="M26 20V132H40M26 36H40M56 46V92H70M56 64H70" />
      <text x="46" y="40">notes/</text>
      <text x="76" y="68">todo.md</text>
      <text x="76" y="96">ideas.md</text>
      <text x="46" y="136">draft.md</text>
    </g>
    <path className="agent-view-leader" d="M144 63H156" />
    <text className="agent-view-note" x="160" y="67">buy milk</text>
  </g>
)

const backends = [
  { name: "filesystem", Icon: HardDrive },
  { name: "in memory", Icon: Cpu },
  { name: "sqlite", Icon: Database },
  { name: "pigeon", Icon: Bird },
  { name: "", Icon: Question },
] as const

// Backends branches from the workspace to the storage options below the line; the solid branch is the one in use, and the dashed branches could hold the same tree.
const Backends = ({ from, centers, y }: { readonly from: readonly [number, number]; readonly centers: ReadonlyArray<number>; readonly y: number }): ReactElement => {
  const rail = from[1] + 34
  return (
    <g>
      <path className="agent-view-branch agent-view-branch-alternate" d={centers.slice(1).map(cx => `M${from[0]} ${rail}H${cx}V${y}`).join("")} />
      <path className="agent-view-branch" d={`M${from[0]} ${from[1]}V${rail}H${centers[0]}V${y}`} />
      <circle className="agent-view-joint" cx={from[0]} cy={rail} r="3" />
      {backends.map((backend, index) => <g key={backend.name} transform={`translate(${centers[index]! - 21} ${y})`}>
        <rect className="agent-view-tile" width="42" height="42" />
        <backend.Icon className="agent-view-glyph" x="9" y="9" size={24} weight="light" />
        <text className="agent-view-backend" x="21" y="58" textAnchor="middle">{backend.name}</text>
      </g>)}
    </g>
  )
}

const Arrow = ({ id }: { readonly id: string }): ReactElement => (
  <defs>
    <marker id={id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0L8 4L0 8Z" />
    </marker>
  </defs>
)

export const AgentViewDiagram = (): ReactElement => {
  const desktop = useId()
  const mobile = useId()
  return (
    <figure className="agent-view">
      <svg className="agent-view-desktop" viewBox="0 0 700 330" role="img" aria-label={label}>
        <Arrow id={desktop} />
        <image href={tardie} x="0" y="64" width="180" height="130" />
        <text className="agent-view-name" x="90" y="214" textAnchor="middle">Agent</text>
        <g className="agent-view-calls">
          <text x="196" y="74">write_file("/notes/todo.md",</text>
          <text x="196" y="90">{"  \"buy milk\")"}</text>
          <path d="M188 100H380" markerEnd={`url(#${desktop})`} />
          <text x="196" y="140">read_file("/notes/todo.md")</text>
          <path d="M188 150H380" markerEnd={`url(#${desktop})`} />
          <path className="agent-view-return" d="M380 178H188" markerEnd={`url(#${desktop})`} />
          <text className="agent-view-result" x="196" y="198">"buy milk"</text>
        </g>
        <Workspace x={390} y={40} />
        <path className="agent-view-horizon" d="M0 224H700" />
        <Backends from={[510, 208]} centers={[358, 434, 510, 586, 662]} y={262} />
      </svg>
      <svg className="agent-view-mobile" viewBox="0 0 360 572" role="img" aria-label={label}>
        <Arrow id={mobile} />
        <image href={tardie} x="90" y="0" width="180" height="130" />
        <text className="agent-view-name" x="180" y="146" textAnchor="middle">Agent</text>
        <g className="agent-view-calls">
          <text x="180" y="180" textAnchor="middle">write_file("/notes/todo.md", "buy milk")</text>
          <text x="180" y="202" textAnchor="middle">read_file("/notes/todo.md")</text>
          <path d="M164 214V256" markerEnd={`url(#${mobile})`} />
          <path className="agent-view-return" d="M196 256V214" markerEnd={`url(#${mobile})`} />
          <text className="agent-view-result" x="204" y="240">"buy milk"</text>
        </g>
        <Workspace x={60} y={282} />
        <path className="agent-view-horizon" d="M0 466H360" />
        <Backends from={[180, 450]} centers={[44, 112, 180, 248, 316]} y={504} />
      </svg>
    </figure>
  )
}
