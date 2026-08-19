How to gate tools from the log: hide, reveal, or revoke tools based on what has happened.

The first move is a reclassification: "which tools exist right now" is a value derived from history, so it is a projection. The reactors only consume it, at two points.

### The offer

The model knows about tools only because `runLlm`'s input says so. Derive the list:

```ts
// availableTools: the toolbox minus what the log has revoked.
const availableTools: Projection<string[]> = (events) =>
  Object.keys(toolbox).filter((name) => failures(events, name) < 3)
```

```ts
const infer: Reactor = (events) => {
  ...
  return [{ key: `llm/${attempt}`, input: { trajectory: events, tools: availableTools(events) }, act: runLlm }]
}
```

Any policy expressible over the log fits in the projection: hide deploy until a `PlanApproved` event exists, reveal a dangerous tool only after an `OperatorGranted` landing (an operator appends one with a plain `send`), retire a tool whose failure count crossed a threshold. Progressive disclosure, circuit breakers, and human approval are the same shape: an event vocabulary plus a projection.

### The enforcement

The offer is advice; a model can hallucinate a call to a hidden tool. The tools reactor consults the same projection:

```ts
const tools: Reactor = (events) => {
  const allowed = availableTools(events)
  return unansweredCalls(events).map((call) => ({
    key: call.callId,
    input: call,
    act: allowed.includes(call.name) ? runTool : deny,
  }))
}

// deny answers a call to a hidden tool. The model sees the refusal in its
// next trajectory and self-corrects.
const deny = async (call: ToolCalled): Promise<ToolReturned[]> =>
  [{ type: "ToolReturned", callId: call.callId, result: { error: `${call.name} is unavailable` } }]
```

### The words that come with the offer

The prompt that names the tools is a projection too. A capability's `system` is a string or a function of the log, so the text that describes a tool is derived where the tool list is derived, and the render is one function of one log.

```ts
// packagesSystem: the block naming what the model can reach, folded from the same log.
const catalog = { name: "catalog", system: (events) => `<packages>\n${namesIn(events).join("\n")}\n</packages>` }
```

A capability that ships a default fragment takes a replacement at the surface that applies it, the way a policy value does (policy.md). `codeModeFor({}, { system })` swaps code mode's `CODE_SYSTEM` for a host's own, and the exported default says what the swap replaced.

### Why this cannot drift

Offer and enforcement are the same pure function of the same log, read twice. There is no tool registry to fall out of sync with the prompt. The policy is testable by handing `availableTools` event arrays, and auditable after the fact: for any recorded settle, re-derive exactly which tools the model was shown.

One subtlety: the key stays `llm/${attempt}` after the input grows. Availability is part of the input; it is never part of the identity.
