# Effect dependencies

The workspace uses upstream Effect and published provider packages from the [Effect fork](https://github.com/clavia-labs/effect/tree/clavia/ai-providers). It has no local dependency patches.

| Package | Version | Purpose |
| --- | --- | --- |
| `effect` | `4.0.1` | Stable Effect runtime |
| `@tardie/ai-bedrock` | `4.0.1-clavia.0` | AWS Bedrock Converse provider |
| `@tardie/ai` | `0.1.0` | Shared deferred tool validation and response formats |
| `@tardie/ai-openai` | `4.0.1-clavia.0` | OpenAI Responses provider |
| `@tardie/ai-anthropic` | `4.0.1-clavia.1` | Anthropic provider |
| `@tardie/ai-openai-compat` | `4.0.1-clavia.1` | OpenAI-compatible chat completions provider |
| `@tardie/ai-openrouter` | `4.0.1-clavia.1` | OpenRouter provider |

[CLAVIA_PATCHES.md](https://github.com/clavia-labs/effect/blob/clavia/ai-providers/CLAVIA_PATCHES.md) records each provider change and its upstream status. [CLAVIA_PUBLISHING.md](https://github.com/clavia-labs/effect/blob/clavia/ai-providers/CLAVIA_PUBLISHING.md) describes package publication.

Run `bun run gate --only=typecheck:model,typecheck:agent,test:model,test:agent` to check the Tardigrade integration. The Effect fork contains provider source checks and package publication checks.
