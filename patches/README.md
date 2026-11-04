# Effect dependencies

The workspace uses upstream Effect and published provider packages from the [Effect fork](https://github.com/clavia-labs/effect/tree/clavia/ai-providers). It has no local dependency patches.

| Package | Version | Purpose |
| --- | --- | --- |
| `effect` | `4.1.2` | Upstream Effect runtime |
| `@tardie/ai` | `0.2.0` | Scoped response formats and tool-result file placement |
| `@tardie/ai-bedrock` | `4.1.2-clavia.0` | AWS Bedrock Converse streaming provider |
| `@tardie/ai-openai` | `4.1.2-clavia.0` | OpenAI Responses provider |
| `@tardie/ai-anthropic` | `4.1.2-clavia.0` | Anthropic provider |
| `@tardie/ai-openai-compat` | `4.1.2-clavia.0` | OpenAI-compatible chat completions provider |
| `@tardie/ai-openrouter` | `4.1.2-clavia.0` | OpenRouter provider |

[CLAVIA_PATCHES.md](https://github.com/clavia-labs/effect/blob/clavia/ai-providers/CLAVIA_PATCHES.md) records each provider change and the test that proves it. [CLAVIA_PUBLISHING.md](https://github.com/clavia-labs/effect/blob/clavia/ai-providers/CLAVIA_PUBLISHING.md) describes package publication.

Run `bun run gate --only=typecheck:model,typecheck:agent,test:model,test:agent` to check the Tardigrade integration. The Effect fork contains provider source checks and package publication checks.
