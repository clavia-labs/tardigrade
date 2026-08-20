# Runtime and turn recovery

Tardigrade uses a turn as its unit of durable work. A turn starts with one inbound message and ends with `TurnCompleted` or `TurnFailed`. One turn can contain many inference attempts and tool calls. A campaign is an application term for a group of turns. The framework does not create campaign records.

## Runtime

Tardigrade requires Bun 1.4.0 or later. CI uses the Bun canary channel until Bun 1.4 has a stable release. `MINIMUM_BUN_VERSION` exposes this requirement, and the public runtime entry points reject older Bun releases.

Bun 1.3 can end a fetch after about five idle minutes even when the request declares a longer deadline. This [Bun defect](https://github.com/oven-sh/bun/issues/16682) can terminate a valid long inference. The [runtime repair](https://github.com/oven-sh/bun/pull/33647) lets the explicit request deadline control the call. `ModelConfig.stream` remains the operator's source for first-chunk, idle, and total stream limits.

## Automatic retries

The model binding retries throttle-shaped failures inside one inference operation. These failures include rate limits, server failures, connection resets, and stream timeouts. `DEFAULT_THROTTLE_RETRY_DELAYS_MS` is `[2000, 8000, 30000]`, so the default permits three retries after the first request. `ModelConfig.throttleRetryDelaysMs` accepts another list, including an empty list. A valid `Retry-After` value takes priority when it fits the configured ceiling.

Retry exhaustion returns a failed model action. The agent records it as `TurnFailed`, with the failure cause, attempt count, logical attempt key, and effective retry policy. Missing provider usage remains unknown. The framework does not invent token or cost data.

`InferPolicy.giveUpAfter` covers a different failure. It bounds repeated process deaths that leave `ModelCalled` without a consequence. Its default is three, and `policy.infer.giveUpAfter` can replace it.

## Operator resume

`TurnFailed` is the failure terminal for one execution epoch. `TurnResumed` records an operator command that opens the next epoch. It is not another terminal state. The original failure remains in the append-only log, while current-state projections select the latest epoch.

```ts
const first = await agent.run("Review the contract")

if (first.error !== undefined) {
  const retried = await agent.resume(first.turn)
  console.log(retried)
}
```

An assembly that owns its host can use the same operation directly.

```ts
await resumeTurn(host, "ag.root", turn)
```

Resume accepts only a turn whose active epoch ended in `TurnFailed`. It preserves committed tool calls and results, removes the superseded failure from the next model request, and resets the epoch retry counters. The operation returns the new boundary to the operator. It does not redeliver the turn's original reply. A failed inference keeps its logical idempotency key. A model-declared failure advances to a new inference key because the prior model response completed.

Provider behavior limits the delivery guarantee. The OpenAI-compatible binding sends the logical key as `Idempotency-Key`. Bedrock Converse has no equivalent request field, so a replay remains at least once. A timed-out Bedrock request can finish after the client loses the response, and its exact replay can incur another charge.

Automatic retries stop at `TurnFailed`. Resume is an explicit operator choice because it can spend money and repeat a provider-side effect.
