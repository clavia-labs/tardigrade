import type { ReactElement } from "react"
import { WorldGlobe } from "./artwork/WorldGlobe"
import { Discord, Github } from "./icons"

const REPOSITORY = "https://github.com/clavia-labs/tardigrade"

const ConsoleScene = (): ReactElement => (
  <div className="console-scene" aria-label="A tardigrade floating above Earth">
    <div className="console-log-clouds" aria-hidden="true">
      <div className="console-log-cloud console-log-cloud-a"><span /><span /><span /><span /></div>
      <div className="console-log-cloud console-log-cloud-b"><span /><span /><span /></div>
      <div className="console-log-cloud console-log-cloud-c"><span /><span /><span /><span /></div>
    </div>
    <div className="console-earth"><WorldGlobe /></div>
    <img className="console-tardie" src="/images/tardie.png" alt="A technical illustration of a tardigrade" />
    <span className="console-scene-label console-scene-label-earth">earth / online</span>
  </div>
)

export const ConsolePage = (): ReactElement => (
  <main className="console-page">
    <section className="console-hero">
      <div className="console-copy">
        <h1>Console is<br />coming soon.</h1>
        <p>Deploy, inspect, and operate durable agents from one hosted workspace.</p>
        <div className="console-actions">
          <a className="button button-secondary" href={REPOSITORY} rel="noreferrer" target="_blank"><Github />Follow on GitHub</a>
          <a className="button button-secondary" href="https://discord.gg/Z74jwRxz4k" rel="noreferrer" target="_blank"><Discord />Join Discord</a>
        </div>
      </div>
      <ConsoleScene />
    </section>
  </main>
)
