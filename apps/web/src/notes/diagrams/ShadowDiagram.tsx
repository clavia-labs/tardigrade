import type { ReactElement } from "react"

// TardieSilhouette is tardie's outline from assets/mascot/tardie-normal.svg: the body and the four far legs, centred on the origin; eye cuts out the near eye so the held figure reads as a creature while its shadow stays solid.
export const TardieSilhouette = ({ x, y, scale, className, eye = false }: { readonly x: number; readonly y: number; readonly scale: number; readonly className?: string; readonly eye?: boolean }): ReactElement => (
  <g className={className} transform={`translate(${x} ${y}) scale(${scale}) translate(-150 -145)`}>
    {[79, 123, 169, 219].map((leg) => <path key={leg} transform={`translate(${leg} 177)`} d="M-12 -8Q-20 6-12 21Q-5 28 5 23Q15 17 9-8Z" />)}
    <path d="M47 160Q39 137 56 125Q53 105 80 104Q89 86 117 94Q134 78 157 91Q179 77 197 96Q226 90 241 116Q258 141 241 162Q237 174 220 178Q222 197 211 202Q197 208 191 197L189 185Q178 190 169 187Q172 202 159 206Q146 210 141 198L139 185Q129 191 123 188Q125 203 113 207Q100 210 95 198L94 181Q84 182 80 177Q83 195 70 201Q56 206 50 192Q43 178 47 160Z" />
    {eye ? <circle className="shadow-diagram-eye" cx="216" cy="124" r="9" /> : null}
  </g>
)

// FORM, FLAME_X and WALL_X place tardie, the column of flames, and the shadows on the wall; every ray runs from a flame through FORM, so the shadows sit where straight light would put them.
const FORM = { x: 300, y: 150 } as const
const FLAME_X = 100
const WALL_X = 584
// FLAME_SPREAD is the vertical distance between neighbouring flames.
const FLAME_SPREAD = 60

// ShadowDiagram is a cropped callback to CaveDiagram: one flame per store casts tardie's shadow onto the cave wall from its own angle, and each shadow is labeled with its store; name labels tardie and form labels the stick it is held up on; flames are listed top to bottom, so the first store's shadow lands lowest.
export const ShadowDiagram = ({ name, form, shadows }: { readonly name: string; readonly form: string; readonly shadows: ReadonlyArray<string> }): ReactElement => {
  const reach = (WALL_X - FORM.x) / (FORM.x - FLAME_X)
  const casts = shadows.map((store, index) => {
    const flameY = FORM.y + (index - (shadows.length - 1) / 2) * FLAME_SPREAD
    const slope = (FORM.y - flameY) / (FORM.x - FLAME_X)
    return { store, flameY, wallY: FORM.y + (FORM.y - flameY) * reach, skew: Math.atan(slope) * 180 / Math.PI * 1.4 }
  })
  const height = Math.max(...casts.map((cast) => cast.wallY)) + 56
  return (
    <svg className="shadow-diagram" viewBox={`0 0 640 ${height}`} role="img" aria-label={`${shadows.length} flames light the silhouette of tardie, labeled ${name} and held up as a ${form}, from different angles, and each casts a differently slanted shadow onto the cave wall, labeled ${shadows.join(", ")}.`}>
      <g className="cave-ink"><path d={`M640 0H530C518 ${height * 0.2} 526 ${height * 0.4} 516 ${height * 0.56}C508 ${height * 0.72} 518 ${height * 0.88} 526 ${height}H640Z`} /></g>
      <path className="cave-rays" d={casts.map((cast) => `M${FLAME_X + 4} ${cast.flameY}L${WALL_X - 44} ${cast.wallY - (cast.wallY - cast.flameY) * 44 / (WALL_X - FLAME_X)}`).join("")} />
      {casts.map((cast) => (
        <g key={cast.store}>
          <path className="cave-flame" transform={`translate(${FLAME_X - 98 * 0.42} ${cast.flameY - 62 * 0.42}) scale(.42)`} d="M48 94C40 82 44 62 56 50C56 60 60 66 64 66C60 48 70 30 86 14C82 30 86 40 90 46C94 42 96 38 98 34C102 48 104 60 100 72C98 84 92 94 82 94Z" />
          <ellipse className="cave-light" cx={WALL_X} cy={cast.wallY} rx="44" ry="28" transform={`rotate(${cast.skew * 0.5} ${WALL_X} ${cast.wallY})`} />
          <g transform={`translate(${WALL_X} ${cast.wallY}) skewY(${cast.skew})`}><TardieSilhouette className="cave-shape-fill" x={0} y={0} scale={0.24} /></g>
        </g>
      ))}
      <g className="cave-object">
        <TardieSilhouette x={FORM.x} y={FORM.y} scale={0.28} eye />
        <path className="cave-stick" d={`M${FORM.x} ${FORM.y + 20}V${height - 32}`} />
        <path className="cave-limb" d={`M${FORM.x - 34} ${height - 40}L${FORM.x} ${height - 58}`} />
      </g>
      <g className="cave-labels">
        <text x={FORM.x} y={FORM.y - 34} textAnchor="middle">{name}</text>
        <text x={FORM.x} y={height - 12} textAnchor="middle">{form}</text>
        {casts.map((cast) => <text key={cast.store} className="cave-label-on-rock" x={WALL_X} y={cast.wallY + 44} textAnchor="middle">{cast.store}</text>)}
      </g>
    </svg>
  )
}
