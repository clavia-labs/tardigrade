import fc from "fast-check"
import { FactoryGlyph } from "./FactoryPathsDiagram"
import { useMemo, type ReactElement } from "react"
import { DEFAULT_VERIFICATION_PREVIEW_RUNS, DEFAULT_FACTORY_PATH_STEPS, DEFAULT_FACTORY_POLICY, factoryPath, type FactoryAction, type FactoryPolicy } from "./factory-path"

export const DEFAULT_VERIFICATION_PREVIEW_SEED = 3

export const VerificationResultsDiagram = ({ policy = DEFAULT_FACTORY_POLICY, numRuns = DEFAULT_VERIFICATION_PREVIEW_RUNS, maxSteps = DEFAULT_FACTORY_PATH_STEPS, seed = DEFAULT_VERIFICATION_PREVIEW_SEED, enforceRules = false }: { readonly policy?: FactoryPolicy; readonly numRuns?: number; readonly maxSteps?: number; readonly seed?: number; readonly enforceRules?: boolean }): ReactElement => {
  const results = useMemo(() => fc.sample(fc.array(fc.constantFrom<FactoryAction>("inspect", "produce", "treat"), { minLength: 1, maxLength: maxSteps }), { seed, numRuns }).map((actions) => { const trace = factoryPath(actions, policy, { enforceRules }); return { actions, trace, final: trace.at(-1)! } }), [policy, numRuns, maxSteps, seed, enforceRules])
  const passed = results.filter(({ final }) => final.violation === undefined).length
  const tile = (x: number, y: number, unsafe = false): ReactElement => <g key={`${x},${y}`} transform={`translate(${x} ${y})`}>
    <rect className="verification-tile" data-kind={unsafe ? "unsafe" : "safe"} width="14" height="14" />
    <path className="verification-tile-light" d="M1 13V1h12l-2 2H3v8Z" />
    <path className="verification-tile-shadow" d="M1 13h12V1l-2 2v8H3Z" />
  </g>
  const shared = new Map<string, { x: number; y: number }>()
  const ends = new Map<number, { x: number; y: number; startX: number }>()
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    const length = Math.abs(x2 - x1) + Math.abs(y2 - y1)
    for (let step = 0; step <= length; step++) {
      const x = x1 + Math.sign(x2 - x1) * step
      const y = y1 + Math.sign(y2 - y1) * step
      shared.set(`${x},${y}`, { x, y })
    }
  }
  const depth = Math.ceil(Math.log2(Math.max(1, results.length)))
  const reach = depth * 6 + 7
  const branch = (first: number, last: number, x: number): { x: number; y: number } => {
    const y = 2 + (first + last) * 2
    if (first === last) {
      ends.set(first, { x: reach + (first % 3) * 2, y, startX: x })
      return { x, y }
    }
    const middle = Math.floor((first + last) / 2)
    for (const [start, end] of [[first, middle], [middle + 1, last]]) {
      const child = branch(start!, end!, x + 6)
      line(x, y, x + 2, y)
      line(x + 2, y, x + 2, child.y)
      line(x + 2, child.y, child.x - 1, child.y)
    }
    return { x, y }
  }
  const root = branch(0, results.length - 1, 1)
  line(0, root.y, root.x, root.y)
  return <figure className="verification-results" data-enforced={enforceRules}>
    <div className="verification-results-summary"><span>{results.length} sampled paths{enforceRules ? " · guard enabled" : ""}</span><span>{passed} pass · {results.length - passed} fail</span></div>
    <svg viewBox={`0 0 ${(reach + maxSteps + 6) * 18} ${(results.length * 4 + 2) * 18}`} role="img" aria-label="Sampled action paths branch through a tiled maze. Each path shows its actions, rule result, tank contents, spill, and paperclip count.">
      {Array.from(shared.values(), ({ x, y }) => tile(12 + x * 18, y * 18))}
      {results.map(({ final, trace }, index) => {
        const end = ends.get(index)!
        const y = end.y * 18
        const failed = final.violation !== undefined
        const endX = 12 + (end.startX + trace.length) * 18
        const reason = final.violation === "Production before inspection" ? "no inspection" : final.violation === "Wastewater escaped into the surroundings" ? "overflow" : undefined
        return <g className="verification-result-row" data-failed={failed} key={index} aria-label={`Path ${index + 1}: ${trace.map((state) => state.action).join(", ")}; ${failed ? `fail, ${final.violation}` : "pass"}`}>

          {trace.map((state, step) => <g key={step} transform={`translate(${12 + (end.startX + step) * 18} ${y})`}>
            <rect className="verification-tile" data-kind={state.violation ? "unsafe" : "safe"} width="14" height="14" />
            <path className="verification-tile-light" d="M1 13V1h12l-2 2H3v8Z" />
            <path className="verification-tile-shadow" d="M1 13h12V1l-2 2v8H3Z" />
            <g className="verification-result-action" data-unsafe={state.violation !== undefined} transform="translate(1 1) scale(.375)"><FactoryGlyph kind={state.action} /></g>
          </g>)}
          {tile(endX, y, failed)}
          <text x={endX + 29} y={y + 11}>{failed ? `FAIL · ${reason ?? "rule broken"}` : "PASS"}</text>
          <g className="verification-result-tank" transform={`translate(${endX + 30} ${y + 22})`}>
            <rect className="factory-tank-water" x="2" y={24 - final.water / policy.capacity * 20} width="26" height={final.water / policy.capacity * 20} />
            <path className="factory-tank-wall" d="M0 0v26h30V0" />
            <path className="factory-tank-limit" d="M-3 4h36" />
            <text className="verification-result-water" x="41" y="9">{final.water}/{policy.capacity}</text>
            <text className="verification-result-spill" data-polluted={final.pollution > 0} x="41" y="25">spill {final.pollution}</text>
            <text className="verification-result-clips" x="41" y="41">clips {final.clips.toLocaleString("en-US")}</text>
          </g>
          {failed ? <g className="verification-tile-mark" transform={`translate(${endX + 7} ${y + 7})`}><path d="M0-6v12M-6 0H6M-4-4 4 4M4-4-4 4" /><circle className="verification-mine" r="3" /></g> : <g className="verification-tile-mark" transform={`translate(${endX + 7} ${y + 7})`}><path d="M-3 5V-5m-2 10h7" /><path className="verification-flag" d="M-2-5h7v6h-7Z" /><path className="verification-flag-checks" d="M-2-5h3v3h-3Zm3 3h4v3H1Z" /></g>}
        </g>
      })}
    </svg>

    <figcaption>{enforceRules ? "The same sampled requests with the guard enabled. Unsafe production is rejected; the tank stays within capacity and nothing spills. PASS checks safety, not whether the production goal was reached." : "Real fast-check samples of the toy factory, separate from the proposed 1,000-run actor check. Each tile shows its sampled action and turns red from the first violation. Endpoints show final tank contents, spilled waste, and paperclips produced. PASS means no safety rule was broken on that trace."}</figcaption>
  </figure>
}
