import type { ReactElement } from "react"

const Plate = ({ y }: { readonly y: number }): ReactElement => (
  <g transform={`translate(160 ${y})`}>
    <path className="host-layer-side" d="M28 70L188 140L348 70V81L188 151L28 81Z" />
    <path className="host-layer-top" d="M188 0L348 70L188 140L28 70Z" />
  </g>
)

export const HostLayersDiagram = (): ReactElement => (
  <svg className="host-layers-diagram" viewBox="0 0 520 258" role="img" aria-label="Three closely stacked isometric plates, labelled on the left: the meeseeks actor, application layers supplied through layersFor for inference and other services, and a Bun or Cloudflare host supplying sandbox, workspace, log, and routing.">
    <g className="host-layer-guides" aria-hidden="true">
      <path d="M188 97V166M508 97V166" />
    </g>
    <Plate y={96} />
    <Plate y={56} />
    <Plate y={16} />
    <g className="host-layer-callouts">
      <path d="M156 91H186M156 131H186M156 171H186" />
      <text x="12" y="80">Actor</text>
      <text className="host-layer-code" x="12" y="97">meeseeks</text>
      <text className="host-layer-code" x="12" y="123">layersFor</text>
      <text x="12" y="140">Inference, services</text>
      <text className="host-layer-code" x="12" y="166">Bun / Cloudflare</text>
      <text x="12" y="183">Sandbox, workspace</text>
      <text x="12" y="200">Log / routing</text>
    </g>
  </svg>
)
