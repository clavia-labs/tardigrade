import { useId, useState, type ReactElement } from "react"

const states = [
  { name: "Green", output: "Go", lamp: 2 },
  { name: "Yellow", output: "Prepare to stop", lamp: 1 },
  { name: "Red", output: "Stop", lamp: 0 }
] as const

export const TrafficLightDiagram = (): ReactElement => {
  const glowId = useId()
  const grainId = useId()
  const [current, setCurrent] = useState(0)
  const state = states[current]!
  // nextIndex is the only state one timer tick away; clicking it advances the light.
  const nextIndex = (current + 1) % states.length
  const advance = () => setCurrent(nextIndex)
  return (
    <figure className="traffic-machine" aria-label="A traffic light state machine">
      <div className="traffic-machine-body">
        <div className="traffic-result">
          <span className="ship-projection-label">Traffic light</span>
      <svg viewBox="50 10 160 205" role="img" aria-label={`Current state: ${state.name}. Each timer event advances green to yellow, yellow to red, then red to green.`}>
        <defs>
          <filter id={glowId} x="-100%" y="-100%" width="300%" height="300%" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="soft" />
            <feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="3" seed="7" result="noise" />
            <feColorMatrix in="noise" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  2.5 0 0 0 -.7" result="grain" />
            <feComposite in="soft" in2="grain" operator="in" />
          </filter>
          <filter id={grainId} x="-30%" y="-30%" width="160%" height="160%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="1.2" numOctaves="3" seed="12" result="noise" />
            <feColorMatrix in="noise" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  3 0 0 0 -1.1" result="grain" />
            <feComposite in="SourceGraphic" in2="grain" operator="in" />
          </filter>
        </defs>
        <g transform="translate(130 0)" className="traffic-state">
            <path className="traffic-base" d="m-22 191 21-8 20 10-21 8Z" />
            <path className="traffic-post" d="M-7 162v29l7 4 7-3v-33M0 166v29" />
            <path className="traffic-side" d="m-46 40 28 16v116l-28-16Z" />
            <path className="traffic-top" d="m-46 40 44-16 28 16-44 16Z" />
            <path className="traffic-sketch" d="M-41 52v97m5-94v96" />
            <g transform="matrix(.88 -.32 0 1 -18 56)">
              <rect className="traffic-housing" width="50" height="116" rx="3" />
              {[0, 1, 2].map((lamp) => (
                <g key={lamp} className="traffic-lens" data-color={["red", "yellow", "green"][lamp]} transform={`translate(25 ${22 + lamp * 36})`}>
                  {state.lamp === lamp && (
                    <g className="traffic-lamp-rays" aria-hidden="true">
                      {[[-76, 9, .25], [-48, 15, .4], [-18, 21, .5], [8, 17, .35], [34, 24, .4], [61, 12, .3], [103, 8, .2], [156, 11, .18], [201, 8, .2], [237, 12, .22]].map(([angle, length, opacity]) => (
                        <path key={angle} transform={`rotate(${angle})`} d={`M15-.7Q${19 + length! / 2} -1.5 ${15 + length!} 0Q${19 + length! / 2} 1.2 15 .7Z`} opacity={opacity} />
                      ))}
                    </g>
                  )}
                  {state.lamp === lamp && <circle className="traffic-lamp-glow" r="17" filter={`url(#${glowId})`} />}
                  <circle className="traffic-lamp" data-color={["red", "yellow", "green"][lamp]} data-lit={state.lamp === lamp} r="12" />
                  {state.lamp === lamp && <circle className="traffic-lamp-grain" r="11.5" filter={`url(#${grainId})`} />}
                </g>
              ))}
            </g>
        </g>
      </svg>
        </div>
        <div className="traffic-cycle">
          <span className="ship-projection-label">State machine</span>
          <svg viewBox="0 0 340 260" role="img" aria-label={`Each time the timer expired, green moved to yellow, yellow to red, and red to green. The current state is ${state.name}.`}>
            <g className="traffic-cycle-links">
              <path data-active={current === 0} d="M94 60H244m-8-5 8 5-8 5" />
              <path data-active={current === 1} d="m260 89-70 88m1-10-1 10 10-3" />
              <path data-active={current === 2} d="m150 177-70-88m0 10 0-10 10 3" />
            </g>
            <g className="traffic-cycle-labels">
              <text x="170" y="43">timer expired</text>
              <text x="276" y="143">timer expired</text>
              <text x="64" y="143">timer expired</text>
            </g>
            {states.map((item, index) => {
              const open = index === nextIndex
              return <g key={item.name} transform={`translate(${[60, 280, 170][index]} ${index === 2 ? 205 : 60})`} className="traffic-cycle-node" data-current={current === index} data-reachable={open} role="button" tabIndex={open ? 0 : -1} aria-disabled={!open} aria-label={open ? `${item.name}: timer expired` : `${item.name} (not reachable now)`} onClick={() => { if (open) advance() }} onKeyDown={(event) => { if (open && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); advance() } }}>
                {open && <circle className="agent-state-halo" r="40" />}
                <circle r="33" />
                <text y="4">{item.name}</text>
              </g>
            })}
          </svg>
        </div>
      </div>
      <figcaption className="agent-state-prompt" aria-live="polite">The light is {state.name.toLowerCase()}. The timer expired: click {states[nextIndex]!.name}.</figcaption>
    </figure>
  )
}
