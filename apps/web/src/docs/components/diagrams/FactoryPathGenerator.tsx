import fc from "fast-check"
import { useMemo, useState, type CSSProperties, type ReactElement } from "react"
import { FactoryGlyph } from "./FactoryPathsDiagram"
import { DEFAULT_VERIFICATION_PREVIEW_SEED } from "./VerificationResultsDiagram"
import { DEFAULT_FACTORY_EXPLORER_LIMITS, DEFAULT_FACTORY_EXPLORER_PATHS, DEFAULT_FACTORY_PATH_STEPS, DEFAULT_FACTORY_POLICY, factoryPath, type FactoryAction, type FactoryPolicy } from "./factory-path"


export const FactoryPathGenerator = ({ policy = DEFAULT_FACTORY_POLICY, steps = DEFAULT_FACTORY_PATH_STEPS, numPaths = DEFAULT_FACTORY_EXPLORER_PATHS, initialSeed = DEFAULT_VERIFICATION_PREVIEW_SEED, limits = DEFAULT_FACTORY_EXPLORER_LIMITS }: { readonly policy?: FactoryPolicy; readonly steps?: number; readonly numPaths?: number; readonly initialSeed?: number; readonly limits?: { readonly maxSteps: number; readonly maxPaths: number } }): ReactElement => {
  const [stepInput, setStepInput] = useState(String(steps))
  const [pathInput, setPathInput] = useState(String(numPaths))
  const [settings, setSettings] = useState({ steps, paths: numPaths, seed: initialSeed })
  const results = useMemo(() => fc.sample(fc.array(fc.constantFrom<FactoryAction>("inspect", "produce", "treat"), { minLength: 1, maxLength: settings.steps }), { seed: settings.seed, numRuns: settings.paths }).map((actions) => { const trace = factoryPath(actions, policy); return { trace, final: trace.at(-1)! } }), [settings, policy])
  const passed = results.filter(({ final }) => final.violation === undefined).length
  const rowHeight = Math.min(54, 360 / results.length)
  const tileSize = Math.max(3, Math.min(38, rowHeight - 8, Math.floor((360 - (settings.steps - 1) * 4) / settings.steps)))
  const pathStyle = { "--factory-path-row-height": `${rowHeight}px`, "--factory-path-tile-size": `${tileSize}px` } as CSSProperties
  const generate = () => {
    const nextSteps = Math.min(limits.maxSteps, Math.max(1, Number.parseInt(stepInput, 10) || steps))
    const nextPaths = Math.min(limits.maxPaths, Math.max(1, Number.parseInt(pathInput, 10) || numPaths))
    setStepInput(String(nextSteps))
    setPathInput(String(nextPaths))
    setSettings((current) => ({ steps: nextSteps, paths: nextPaths, seed: current.seed + 1 }))
  }
  return <section className="factory-generator" aria-label="Explore sampled factory paths">
    <div className="factory-generator-header">
      <ul className="factory-action-legend" aria-label="Available actions">
        {(["inspect", "produce", "treat"] as const).map((action) => <li key={action}>
          <svg viewBox="0 0 42 42" aria-hidden="true">
            <rect className="verification-tile" width="42" height="42" />
            <path className="verification-tile-light" d="M1 41V1h40l-5 5H6v30Z" />
            <path className="verification-tile-shadow" d="M1 41h40V1l-5 5v30H6Z" />
            <g className="factory-generated-icon" transform="translate(8 8) scale(.8125)"><FactoryGlyph kind={action} /></g>
          </svg>
          <span>{action === "inspect" ? "Inspect" : action === "produce" ? "Produce" : "Treat"}</span>
        </li>)}
      </ul>
      <div className="factory-generator-controls">
        <label>Max steps <input type="number" min="1" max={limits.maxSteps} inputMode="numeric" value={stepInput} onChange={(event) => setStepInput(event.target.value)} /></label>
        <label>Paths <input type="number" min="1" max={limits.maxPaths} inputMode="numeric" value={pathInput} onChange={(event) => setPathInput(event.target.value)} /></label>
        <button className="factory-generate-button" type="button" onClick={generate}>Generate paths <span aria-hidden="true">↗</span></button>
      </div>
    </div>
    <div className="factory-path-batch" data-dense={results.length > 20} style={pathStyle}>
      <div className="factory-path-batch-summary"><span>{results.length} sampled paths</span><span>{passed} pass · {results.length - passed} fail</span></div>
      <div className="factory-path-batch-rows">
        {results.map(({ trace, final }, index) => <div className="factory-path-batch-row" data-failed={final.violation !== undefined} key={index} title={`Path ${index + 1}: ${trace.map((state) => state.action).join(" → ")} · water ${final.water}/${policy.capacity} · clips ${final.clips} · spill ${final.pollution} · ${final.violation ?? "pass"}`} aria-label={`Path ${index + 1}: ${trace.map((state) => state.action).join(", ")}; ${final.violation ?? "pass"}`}>
          <span className="factory-path-batch-index">{String(index + 1).padStart(2, "0")}</span>
          <div className="factory-path-batch-actions">
            {trace.map((state, step) => <svg key={step} viewBox="0 0 42 42" role="img" aria-label={`${step + 1}. ${state.action}${state.violation ? ", rule broken" : ""}`}>
              <rect className="verification-tile" data-kind={state.violation ? "unsafe" : "safe"} data-action={state.action} width="42" height="42" />
              <path className="verification-tile-light" d="M1 41V1h40l-5 5H6v30Z" />
              <path className="verification-tile-shadow" d="M1 41h40V1l-5 5v30H6Z" />
              <g className="factory-generated-icon" data-unsafe={state.violation !== undefined} transform="translate(8 8) scale(.8125)"><FactoryGlyph kind={state.action} /></g>
            </svg>)}
          </div>
          <span className="factory-path-batch-status">{final.violation ? "FAIL" : "PASS"}</span>
          <span className="factory-path-batch-metrics">Water {final.water}/{policy.capacity} · Clips {final.clips.toLocaleString("en-US")} · Spill {final.pollution}</span>
        </div>)}
      </div>
    </div>
    <p className="factory-generator-note">Seed {settings.seed} · Up to {settings.steps} actions per path · Limits: {limits.maxSteps} steps, {limits.maxPaths} paths. These are samples from the possible paths.{settings.paths > 20 ? " At this scale, hover a row to read its actions and totals." : ""}</p>
  </section>
}
