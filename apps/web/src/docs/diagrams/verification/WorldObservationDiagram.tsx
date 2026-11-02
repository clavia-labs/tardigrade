import type { ReactElement } from "react"
import tardie from "../../../../../../assets/mascot/tardie-worker-with-wrench.svg"

const World = (): ReactElement => (
  <g>
    <circle className="observation-globe" cx="115" cy="190" r="83" />
    <path className="observation-land" d="m53 142 23-19 24 7 5 19-18 11-4 22-20-5-15-17Zm70 40 25-16 29 9 14 26-18 14-4 29-19 16-12-30-16-18Z" />
    <path className="observation-latitude" d="M34 190h162M48 143q67 30 134 0M48 237q67-30 134 0M115 107c-45 40-45 126 0 166m0-166c45 40 45 126 0 166" />
    <g className="observation-tank" transform="translate(46 26) scale(.6)">
      <path d="M82 44h66v91H82Z" />
      <path className="observation-water" d="M87 81q8-6 17 0t17 0 22 0v49H87Z" />
      <path d="M79 38h72M88 58h54m-9 17h9m-9 18h9m-9 18h9" />
    </g>
    <text x="115" y="34" textAnchor="middle">Water tank</text>
    <text x="115" y="303" textAnchor="middle">World</text>
  </g>
)

const Agent = (): ReactElement => (
  <g>
    <image href={tardie} x="45" y="0" width="180" height="126" />
    <text x="135" y="143" textAnchor="middle">Clippy</text>
    <path className="observation-link" d="M135 180v-17m-4 6 4-6 4 6" />
    <rect className="observation-log" x="0" y="185" width="270" height="162" />
    <text x="16" y="208">Actor event log</text>
    <path className="observation-divider" d="M0 221h270" />
    <rect className="observation-event" x="8" y="230" width="254" height="48" />
    <text x="20" y="250">PaperclipsProduced</text>
    <text className="observation-muted" x="20" y="268">{`{ count: 500, wasteAdded: 6 }`}</text>
    <rect className="observation-observed" x="8" y="288" width="254" height="48" />
    <text x="20" y="308">WaterLevelChanged</text>
    <text className="observation-muted" x="20" y="326">{`{ level: 8 }`}</text>
    <path className="observation-link" d="M135 347v23m-4-5 4 5 4-5" />
    <text className="observation-muted" x="135" y="392" textAnchor="middle">Projection → safety rules</text>
  </g>
)

export const WorldObservationDiagram = (): ReactElement => (
  <figure className="world-observation">
    <svg className="world-observation-desktop" viewBox="0 0 740 450" role="img" aria-label="Clippy acts on the world, and a water tank on the globe sends a sensor observation into Clippy's event log. The observation joins recorded actions and feeds projections and safety rules.">
      <g transform="translate(15 100)"><World /></g>
      <g transform="translate(450 10)"><Agent /></g>
      <path className="observation-link" d="M150 180h253v142h47m-7-5 7 5-7 5" />
      <rect className="observation-packet" x="268" y="169" width="24" height="22" />
      <path className="observation-link" d="M274 176h12m-12 7h8" />
      <text x="280" y="157" textAnchor="middle">Sensor</text>
      <path className="observation-link" d="M280 191v16" />
      <rect className="observation-packet" x="187" y="207" width="186" height="48" />
      <text x="280" y="227" textAnchor="middle">WaterLevelChanged</text>
      <text className="observation-muted" x="280" y="245" textAnchor="middle">{`{ level: 8 }`}</text>
      <path className="observation-link" d="M495 78H220v75h-63m7-5-7 5 7 5" />
      <text x="318" y="65" textAnchor="middle">Actions</text>
    </svg>
    <svg className="world-observation-mobile" viewBox="0 0 340 870" role="img" aria-label="Clippy acts on the world, and a tank on the globe sends its observed water level down into Clippy's event log, where projections and safety rules can use it.">
      <g transform="translate(55 70)"><World /></g>
      <path className="observation-link" d="M190 150h134v602h-19m7-5-7 5 7 5" />
      <rect className="observation-packet" x="248" y="139" width="24" height="22" />
      <path className="observation-link" d="M254 146h12m-12 7h8" />
      <text x="260" y="125" textAnchor="middle">Sensor</text>
      <path className="observation-link" d="M260 161v223h-70v12" />
      <rect className="observation-packet" x="97" y="396" width="186" height="40" />
      <text x="190" y="413" textAnchor="middle">WaterLevelChanged</text>
      <text className="observation-muted" x="190" y="429" textAnchor="middle">{`{ level: 8 }`}</text>
      <path className="observation-link" d="M80 500H16V123h128m-7-5 7 5-7 5" />
      <text x="62" y="415">Actions</text>
      <g transform="translate(35 440)"><Agent /></g>
    </svg>
  </figure>
)
