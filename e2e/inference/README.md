# Inference tests

`bun test e2e/inference` runs local provider fixtures. The live reasoning test is skipped by default.

The live test uses a real provider and incurs API charges. It supports OpenAI Responses and Anthropic Messages. Choose a model that supports the configured reasoning mode and supply its context limit.

```sh
export TARDIE_LIVE_PROVIDER=openai
export TARDIE_LIVE_MODEL=<reasoning-model-id>
export TARDIE_LIVE_CONTEXT_TOKENS=<model-context-limit>
# Set OPENAI_API_KEY through your usual secret environment.
bun run --cwd e2e test:live:reasoning
```

For Anthropic, set `TARDIE_LIVE_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, and an Anthropic model ID. The test uses enabled thinking with a token budget.

The test checks these properties:

1. The Bun host stores a continuation before the nonce tool runs.
2. The next provider request contains encrypted or signed reasoning from that stored continuation, plus the tool result.
3. The model completes with the nonce that only the tool supplied.
4. The events and completed result survive host restart without another provider call.

Missing reasoning evidence fails the test. A successful text response alone does not pass. Restart occurs after completion; this test does not cover interruption between model return and tool execution.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `TARDIE_LIVE_TIMEOUT_MS` | `240000` | Turn deadline and provider stream limit |
| `TARDIE_LIVE_MAX_OUTPUT_TOKENS` | `8192` | Output allowance, including reasoning |
| `TARDIE_LIVE_THINKING_TOKENS` | `2048` | Anthropic thinking budget |
| `TARDIE_LIVE_BASE_URL` | Provider API URL ending in `/v1` | Optional provider endpoint override |

OpenAI uses high reasoning effort and disables response storage. Provider retries are disabled. Temporary host storage is removed after the test. Assertions do not print continuation payloads or credentials.
