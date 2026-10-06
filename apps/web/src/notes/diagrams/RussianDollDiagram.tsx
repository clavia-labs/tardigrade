import type { ReactElement } from "react"

// scales lists each doll's size against the largest; the last doll is solid and has no seam, and dolls below 0.45 drop the apron flower.
const scales = [1, 0.76, 0.56, 0.4, 0.27] as const
const gap = 32
const baseline = 174

const Doll = ({ core, scale, x }: { readonly core: boolean; readonly scale: number; readonly x: number }): ReactElement => (
  <g className={`russian-doll${core ? " russian-doll-core" : ""}`} transform={`translate(${x} ${baseline - 170 * scale}) scale(${scale})`}>
    <path className="russian-doll-body" d="M44 0C68 0 80 18 80 44C80 74 88 104 88 132C88 150 86 162 84 170H4C2 162 0 150 0 132C0 104 8 74 8 44C8 18 20 0 44 0Z" />
    <path className="russian-doll-detail" d="M8 74Q44 90 81 74" />
    <ellipse className="russian-doll-face" cx="44" cy="44" rx="20" ry="22" />
    <path className="russian-doll-detail" d="M28 36Q44 22 60 36" />
    <circle className="russian-doll-eye" cx="37" cy="45" r="2" />
    <circle className="russian-doll-eye" cx="51" cy="45" r="2" />
    <path className="russian-doll-detail" d="M41 55Q44 58 47 55" />
    <ellipse className="russian-doll-detail" cx="44" cy="126" rx="30" ry="32" />
    {core ? null : <path className="russian-doll-seam" d="M1 116Q44 124 87 116" />}
    {scale < 0.45 ? null : <>
      {([[44, 119], [37, 126], [51, 126], [44, 133]] as const).map(([cx, cy]) => <circle key={`${cx}-${cy}`} className="russian-doll-detail" cx={cx} cy={cy} r="6" />)}
      <circle className="russian-doll-eye" cx="44" cy="126" r="2" />
    </>}
    <path className="russian-doll-detail" d="M5 160Q44 165 83 160" />
  </g>
)

export const RussianDollDiagram = (): ReactElement => {
  const positions = scales.reduce<ReadonlyArray<number>>((xs, scale, index) => [...xs, index === 0 ? 6 : xs[index - 1]! + 88 * scales[index - 1]! + gap], [])
  return (
    <svg className="russian-doll-diagram" viewBox="0 0 404 178" role="img" aria-label="Five russian dolls in a row, each smaller than the last. The smallest is solid.">
      {scales.map((scale, index) => <Doll key={scale} core={index === scales.length - 1} scale={scale} x={positions[index]!} />)}
    </svg>
  )
}
