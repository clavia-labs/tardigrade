How to set a policy value: a cap, a ceiling, a threshold, or a bound the framework applies on your behalf.

A policy value is a number nobody in the domain chose. How much of a tool result the model reads, how many tool calls a turn gets before it must answer, how large a value must be before it spills to storage: each one is a guess that fits some consumers and not others. The framework states a default for every one of them, and every default is a value you can read and a value you can change. A constant you can read but cannot change is a leaky abstraction, so there are none.

### The shape

Every policy follows the same three-part shape, so knowing one is knowing all of them.

A type names the values and what each one bounds. A `DEFAULT_` constant states the framework's answer. The surface that applies the policy takes a partial override and fills the rest from the default, so you state the one number you care about and inherit the rest.

```ts
// The reactor that applies the policy takes it; the default reactor is the same call with none.
const compact = compactionReactorFor({ fireTokens: 60_000, keepTokens: 12_000 })
const agent = rlmAgentFor(codeSurface(), { budget: { defaultToolBudget: 120 } })
```

The third part is visibility. When a policy changes what the model sees, the output says so. A truncated message names the cap it was cut at and the length it was cut from, and cut console output ends with a line saying it was cut. A model that reads a silent cut treats a fragment as the whole value, and the summary or the answer it writes then states a partial fact as complete.

### Where the values live

The agent applies four policies, gathered as `AgentPolicy` at the assembly so one call sets them all. `context` is the render's truncation caps and compaction's fire and keep lines. `budget` is the tool-call ceiling a brief that states none takes. `infer` is the give-up and repair ceilings. `code` is the size at which a result spills to tmp and leaves a pointer.

The sandbox and the model binding hold the rest. The sandbox bounds captured console output. The model binding bounds the stream (time to first chunk, idle, total), the throttle backoff ladder, and the output-token ladder a truncated answer climbs.

### The one coupling

`context` is the only policy two places apply. Compaction's guard must measure the request the model actually sees, so it counts characters exactly where the render truncates. The reactor runs in the agent; the render runs in the model binding. State the same `context` policy to both, the same way you pass one tool surface to both.

```ts
const context = { messageRenderCap: 40_000, resultRenderCap: 20_000 }
const mind = infer({ baseUrl, apiKey, model, context })   // the binding renders the request with it
const agent = rlmAgentFor(codeSurface(), { context })     // the guard measures with the same one
```

A policy stated in one place and not the other leaves the guard firing against a size no request ever reaches, or never firing while the request grows past the window.
