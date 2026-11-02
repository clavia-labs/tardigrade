import { useId, type ReactElement } from "react"
import { roundedPath } from "../rounded-path"

type Row = { readonly depth: number; readonly label: string; readonly value: string }

const layouts: Record<"cloudflare" | "bun", { readonly label: string; readonly rows: readonly Row[] }> = {
  cloudflare: {
    label: "Durable Object namespaces. ACTORS holds Rick's instance, named meeseeks, rick. THREADS holds his main and lab threads, named meeseeks, rick, main and meeseeks, rick, lab.",
    rows: [
      { depth: 0, label: "Namespace", value: "ACTORS" },
      { depth: 1, label: "Rick's instance", value: `["meeseeks","rick"]` },
      { depth: 0, label: "Namespace", value: "THREADS" },
      { depth: 1, label: "main", value: `["meeseeks","rick","main"]` },
      { depth: 1, label: "lab", value: `["meeseeks","rick","lab"]` },
    ],
  },
  bun: {
    label: "The .tardigrade directory holds Rick's instance database and a threads directory beside it, containing one database for main and one for lab.",
    rows: [
      { depth: 0, label: "Storage directory", value: ".tardigrade/" },
      { depth: 1, label: "Rick's instance database", value: "WyJtZWVzZWVrcyIsInJpY2siXQ.sqlite" },
      { depth: 1, label: "Thread databases", value: "WyJtZWVzZWVrcyIsInJpY2siXQ.sqlite.threads/" },
      { depth: 2, label: "main", value: "bWFpbg.sqlite" },
      { depth: 2, label: "lab", value: "bGFi.sqlite" },
    ],
  },
}

const height = 50, gap = 14, indent = 36
/** Each box hugs its text: about 7.9px per 13px monospace character and 6.6px per 12px label character, plus padding. */
const boxWidth = (row: Row) => Math.ceil(Math.max(row.value.length * 7.9, row.label.length * 6.6) + 30)

export const StorageLayoutDiagram = ({ host }: { readonly host: "cloudflare" | "bun" }): ReactElement => {
  const arrow = useId()
  const { label, rows } = layouts[host]
  const top = (index: number) => 6 + index * (height + gap)
  const left = (row: Row) => 6 + row.depth * indent
  const parent = (index: number) => {
    for (let at = index - 1; at >= 0; at--) if (rows[at]!.depth < rows[index]!.depth) return at
    return -1
  }
  const width = Math.max(...rows.map(row => left(row) + boxWidth(row))) + 6
  return (
    <svg className="actor-instances-diagram storage-layout-diagram" viewBox={`0 0 ${width} ${top(rows.length) - gap + 6}`} style={{ width: `min(100%, ${width}px)` }} role="img" aria-label={label}>
      <defs>
        <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M1 1L7 4L1 7Z" />
        </marker>
      </defs>
      <g className="actor-instances-edges" aria-hidden="true">
        {rows.map((row, index) => {
          const from = parent(index)
          if (from < 0) return null
          const x = left(rows[from]!) + 16
          return <path key={index} d={roundedPath(`M${x} ${top(from) + height}V${top(index) + height / 2}H${left(row) - 4}`)} markerEnd={`url(#${arrow})`} />
        })}
      </g>
      {rows.map((row, index) => (
        <g key={index} transform={`translate(${left(row)} ${top(index)})`}>
          <rect width={boxWidth(row)} height={height} rx="12" />
          <text className="actor-instances-label" x="14" y="19">{row.label}</text>
          <text x="14" y="38">{row.value}</text>
        </g>
      ))}
    </svg>
  )
}
