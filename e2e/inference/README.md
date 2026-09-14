# Inference tests

`bun test e2e/inference` runs local fixtures. It makes no provider requests.

Live tests run only when `TARDIE_LIVE=1` and `TARDIE_LIVE_TARGETS` names one or more targets. A selected target can make paid requests.

```sh
export TARDIE_LIVE_TARGETS=openai-responses
export TARDIE_LIVE_OPENAI_MODEL=<model-id>
export TARDIE_LIVE_OPENAI_CONTEXT_TOKENS=<context-window-tokens>
# Set OPENAI_API_KEY in the ignored repository-root .env.
bun run --cwd e2e test:live:providers
```

Targets are `openai-responses`, `openrouter-chat-completions`, `cloudflare-responses`, `cloudflare-chat-completions`, `anthropic-messages`, and `bedrock-converse`. Use commas to select more than one target.

Cloudflare needs `TARDIE_LIVE_CLOUDFLARE_BASE_URL`. Keep this account endpoint in an ignored environment file. Cloudflare targets use `CLOUDFLARE_AIG_TOKEN`, `TARDIE_LIVE_CLOUDFLARE_MODEL`, and `TARDIE_LIVE_CLOUDFLARE_CONTEXT_TOKENS`.

OpenRouter uses `OPENROUTER_API_KEY`, `TARDIE_LIVE_OPENROUTER_MODEL`, and `TARDIE_LIVE_OPENROUTER_CONTEXT_TOKENS`. Anthropic uses its matching `ANTHROPIC_API_KEY`, model, and context variables. Bedrock uses `AWS_BEARER_TOKEN_BEDROCK`, `TARDIE_LIVE_BEDROCK_REGION`, `TARDIE_LIVE_BEDROCK_MODEL`, and `TARDIE_LIVE_BEDROCK_CONTEXT_TOKENS`. The native AWS endpoint is derived from the region. `TARDIE_LIVE_BEDROCK_ENDPOINT` overrides it. The harness calls the AWS SDK directly and feeds its events through the Bedrock adapter and durable Bun host. It does not use the Cloudflare gateway transport.

A selected target with missing configuration fails with the variable name. An unselected target is not run. It does not pass a live test.

The live command loads the repository-root `.env`; exported environment values take precedence. Normal test runs stay opt-in even when keys are present. Each selected target has a separate test result and deadline.

Live checks are separated by boundary:

| Command suffix | File | What it exercises |
| --- | --- | --- |
| `test:live:providers` | `live/providers.test.ts` | Provider request and response translation through Effect, including tool results and prompt replay |
| `test:live:binding` | `live/binding.test.ts` | Tardie inference requests and outcomes through the Effect binding, without a host |
| `test:live:recovery` | `live/recovery.test.ts` | Durable continuations, tool execution, final output, and completed-turn restart recovery |

`test:live` runs all three suites. Each suite normally makes two provider requests per selected target. `test:live:reasoning` retains the recovery suite as an alias.

`live/targets.ts` declares provider configurations. `live/support/` holds setup, assertions, and protocol inspection. Its deterministic tests validate the runners without paid calls.

The recovery suite checks observed reasoning against persisted and replayed values. A reasoning target fails when required evidence is absent. Restart occurs after completion; it does not cover a crash between model return and tool execution.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `TARDIE_LIVE_TIMEOUT_MS` | `240000` | Turn deadline and stream limit |
| `TARDIE_LIVE_MAX_OUTPUT_TOKENS` | `8192` | Maximum model output tokens |
| `TARDIE_LIVE_THINKING_TOKENS` | `2048` | Anthropic thinking token budget |

The test removes temporary host storage. It does not print credentials, opaque continuation data, or native provider errors.
