# Examples

Both examples run offline through a deterministic inference override. Set `AI_GATEWAY_API_KEY` to run the support agent through the built-in Vercel AI Gateway provider.

```sh
bun run examples/support-agent/main.ts
bun run examples/support-agent/main.ts "What is the total on order 4190?"
bun run examples/replay/main.ts
```

## support-agent

The support agent combines the default pack, one invoice tool, one citation nudge, and the memory runtime.

Read the files in this order:

1. `invoices.ts` is the fake data layer.
2. `native-tools.ts` defines the code-owned native tool surface and handler.
3. `model.ts` provides the offline test model and the optional Vercel gateway binding.
4. `agent.ts` constructs the module tuple.
5. `main.ts` runs a turn and prints the log.

The final line verifies that every emitted event type belongs to the program's declared alphabet.

## replay

The replay example records a complete turn, loads that log into a second memory runtime, and settles it against a model that throws if called.

The proof requires three results:

- the replay makes zero model calls
- the replay appends zero events
- the replay log equals the recording

The script exits with a nonzero status if any result changes.

## Gate

```sh
bun run gate --only=typecheck:examples
bun run gate --only=test:examples
```

[Building an agent](../docs/building-an-agent.md) explains the SDK used here. [Observability](../docs/observability.md) explains replay and branching.
