import { useId, type ReactElement } from "react"
import flying from "../../../../../assets/mascot/tardie-flying.svg"

const Earth = (): ReactElement => {
  const clip = useId()
  return (
    <svg className="flying-earth" viewBox="0 0 140 140" aria-hidden="true">
      <defs><clipPath id={clip}><circle cx="70" cy="70" r="46" /></clipPath></defs>
      <ellipse className="flying-earth-orbit" cx="70" cy="70" rx="66" ry="16" transform="rotate(-18 70 70)" />
      <circle className="flying-earth-sphere" cx="70" cy="70" r="46" />
      <g clipPath={`url(#${clip})`}>
        <path className="flying-earth-grid" d="M24 52Q70 64 116 52M24 88Q70 100 116 88M70 24Q52 70 70 116" />
        <path className="flying-earth-land" d="M34 44Q44 30 60 36Q70 46 58 56Q50 68 38 62Q28 54 34 44ZM74 72Q90 62 104 72Q110 90 94 98Q80 102 76 90Q68 80 74 72ZM76 30Q88 26 96 36Q90 44 80 42Z" />
      </g>
      <path className="flying-earth-stars" d="M14 24h8M18 20v8M120 18h6M123 15v6M116 120h8M120 116v8M10 104h5M12.5 101.5v5" />
    </svg>
  )
}

export const FlyingTardie = (): ReactElement => (
  <figure className="flying-tardie">
    <div className="flying-tardie-earth"><Earth /></div>
    <img src={flying} alt="Tardie flying away from the Earth with a jetpack" width={486} height={400} />
  </figure>
)
