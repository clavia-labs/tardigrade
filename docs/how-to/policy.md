How to set a policy value: a cap, a ceiling, a threshold, or a bound the framework applies on your behalf.

A policy value is a number nobody in the domain chose. How much of a tool result the model reads, how many tool calls a turn gets before it must answer, how large a value must be before it spills to storage: each one is a guess that fits some consumers and not others. The framework states a default for every one of them, and every default is a value you can read and a value you can change. A constant you can read but cannot change is a leaky abstraction, so there are none.

### The shape

Every policy follows the same three-part shape, so knowing one is knowing all of them.

A type names the values and what each one bounds. A `DEFAULT_` constant states the framework's answer. The capability that applies the policy takes a partial override and fills the rest from the default, so you state the one number you care about and inherit the rest.

```ts
// The capability that applies the policy takes it; the bare capability is the same call with none.
const agent = agentOf([codeMode, reply, budgetFor({ defaultToolBudget: 120 }), compactionFor({ fireTokens: 60_000, keepTokens: 12_000 })])
```

The third part is visibility. When a policy changes what the model sees, the output says so. A truncated message names the cap it was cut at and the length it was cut from, and cut console output ends with a line saying it was cut. A model that reads a silent cut treats a fragment as the whole value, and the summary or the answer it writes then states a partial fact as complete.

### Where the values live

The agent applies five policies. Three ride their capabilities: `budget` (the tool-call ceiling a brief that states none takes, `budgetFor`), `context` (the render's truncation caps and compaction's fire and keep lines, `compactionFor`), and `code` (the size at which a result spills to the store and leaves a pointer, `codeModeFor`). `infer` is the runtime's own give-up and repair ceilings, and `agentOf` takes it beside the list. `workspace` bounds what one read or grep of the store can put back into a turn ([workspace.md](workspace.md)). `createRlmAgent` gathers all five as `AgentPolicy` so one option sets them.

The sandbox and the model binding hold the rest. The sandbox bounds captured console output. The model binding bounds the stream (time to first chunk, idle, total), the throttle backoff ladder, and the output-token ladder a truncated answer climbs.

### The one coupling, closed

`context` is the one policy two places apply: compaction's guard must measure the request the model actually sees, so it counts characters exactly where the render truncates. The reactor runs in the agent; the render runs in the model binding. `compactionFor` states the policy once and contributes it to the render, which rides the infer request to the binding, so the guard and the render hold the same numbers by construction and nothing is stated twice.

```ts
const agent = agentOf([codeMode, reply, budget, compactionFor({ messageRenderCap: 40_000, resultRenderCap: 20_000 })])
```
