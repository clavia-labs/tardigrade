import { Eye, TreeView } from "@phosphor-icons/react"
import { useId, type ReactElement } from "react"
import { TardieSilhouette } from "./ShadowDiagram"

// GROUND is where every stick stops; the labels of the held forms sit above their heads so the sticks stay clear.
const GROUND = 292
// MODEL, STORE, and AGENT are the heads of the three held forms.
const MODEL = { x: 70, y: 104 } as const
const STORE = { x: 170, y: 232 } as const
const AGENT = { x: 548, y: 150 } as const
// BOX is the column of capabilities between the forms and the agent; ROWS are their centres, the model's two first and the store's last.
const BOX = { x: 296, width: 112, height: 30 } as const
const ROWS = [62, 142, 232] as const

// Held puts a form on a stick with the carrier's hand gripping it near the ground, as in CaveDiagram.
const Held = ({ x, y, children }: { readonly x: number; readonly y: number; readonly children: ReactElement }): ReactElement => (
  <g className="cave-object">
    {children}
    <path className="cave-stick" d={`M${x} ${y + 24}V${GROUND}`} />
    <path className="cave-limb" d={`M${x - 30} ${GROUND - 6}L${x} ${GROUND - 22}`} />
  </g>
)

// MergeDiagram shows two forms held up in the cave, a language model and a tree shaped store, providing the capabilities an agent requires; the model provides two, the store one, and all three converge on tardie.
export const MergeDiagram = ({ form, model, store, modelProvides, storeProvides }: { readonly form: string; readonly model: string; readonly store: string; readonly modelProvides: readonly [string, string]; readonly storeProvides: string }): ReactElement => {
  const head = useId()
  const capabilities = [...modelProvides, storeProvides]
  const right = BOX.x + BOX.width
  const join = AGENT.x - 70
  return (
    <svg className="merge-diagram" viewBox="0 0 640 316" role="img" aria-label={`Two forms are held up on sticks: an eye labeled ${model} and a file tree labeled ${store}. The ${model} provides ${modelProvides.join(" and ")}, the ${store} provides ${storeProvides}, and all three lead into tardie, held up on a stick labeled ${form}.`}>
      <defs>
        <marker id={head} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path className="merge-head" d="M1 1L9 5L1 9" />
        </marker>
      </defs>
      <g className="merge-lines">
        <path d={`M${MODEL.x + 32} ${MODEL.y}H${BOX.x - 66}C${BOX.x - 30} ${MODEL.y} ${BOX.x - 40} ${ROWS[0]} ${BOX.x - 4} ${ROWS[0]}`} markerEnd={`url(#${head})`} />
        <path d={`M${BOX.x - 66} ${MODEL.y}C${BOX.x - 30} ${MODEL.y} ${BOX.x - 40} ${ROWS[1]} ${BOX.x - 4} ${ROWS[1]}`} markerEnd={`url(#${head})`} />
        <path d={`M${STORE.x + 32} ${STORE.y}H${BOX.x - 4}`} markerEnd={`url(#${head})`} />
        {ROWS.map((row) => <path key={row} d={`M${right + 4} ${row}C${join - 20} ${row} ${join - 30} ${AGENT.y} ${join} ${AGENT.y}`} />)}
        <path d={`M${join} ${AGENT.y}H${AGENT.x - 42}`} markerEnd={`url(#${head})`} />
      </g>
      {ROWS.map((row, index) => (
        <g key={row}>
          <rect className="merge-box" x={BOX.x} y={row - BOX.height / 2} width={BOX.width} height={BOX.height} rx="6" />
          <text className="merge-label" x={BOX.x + BOX.width / 2} y={row + 4} textAnchor="middle">{capabilities[index]}</text>
        </g>
      ))}
      <Held x={MODEL.x} y={MODEL.y}><Eye className="cave-shape" x={MODEL.x - 24} y={MODEL.y - 24} size={48} weight="fill" /></Held>
      <Held x={STORE.x} y={STORE.y}><TreeView className="cave-shape" x={STORE.x - 24} y={STORE.y - 24} size={48} weight="fill" /></Held>
      <Held x={AGENT.x} y={AGENT.y}><TardieSilhouette x={AGENT.x} y={AGENT.y} scale={0.28} eye /></Held>
      <text className="merge-label" x={MODEL.x} y={MODEL.y - 36} textAnchor="middle">{model}</text>
      <text className="merge-label" x={STORE.x} y={STORE.y - 36} textAnchor="middle">{store}</text>
      <text className="merge-label" x={AGENT.x} y={GROUND + 20} textAnchor="middle">{form}</text>
    </svg>
  )
}
