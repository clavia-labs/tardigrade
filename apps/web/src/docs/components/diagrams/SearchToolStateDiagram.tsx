import type { ReactElement } from "react"

export const SearchToolStateDiagram = (): ReactElement => (
  <figure className="search-tool-state" aria-label="Search tool state machine for one request">
    <svg viewBox="0 -24 720 302" role="img" aria-label="The search tool starts idle with no pending requests. ToolCalled adds a request and enables searching the agent and child logs. ToolReturned removes the request and returns the tool to idle.">
      <g className="agent-composition-titles"><text x="24" y="24">SEARCH TOOL</text></g>
      <g className="composition-links">
        <path d="M28 126h89m-8-5 8 5-8 5M243 84Q359-1 477 84m-9-1 9 1-3-9M477 168Q360 252 243 168m3 9-3-9 9 1" />
      </g>
      <g className="search-tool-labels"><text x="66" y="107">initial</text><text x="360" y="5">ToolCalled</text><text x="360" y="22">add a pending request</text><text x="360" y="237">ToolReturned</text><text x="360" y="255">remove the request</text></g>
      <g className="composition-node" data-active="true" transform="translate(185 126)"><circle r="66" /><text className="search-tool-state-title" y="-4">Idle</text><text y="19">no requests</text></g>
      <g className="composition-node" transform="translate(535 126)"><circle r="66" /><text className="search-tool-state-title" y="-4">Searching</text><text y="19">request pending</text></g>
    </svg>
    <figcaption>While a request is pending, the component enables an effect to search the agent's own log and its child agents' logs. This diagram follows one request.</figcaption>
  </figure>
)
