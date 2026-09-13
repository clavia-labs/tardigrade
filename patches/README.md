# Effect dependencies

The workspace uses upstream Effect and published provider packages from the [Effect fork](https://github.com/clavia-labs/effect/tree/clavia/ai-providers). It has no local dependency patches.

| Package | Version | Purpose |
| --- | --- | --- |
| `effect` | `4.0.0-rc.115` | Upstream Effect runtime |
| `@tardie/ai-bedrock` | `0.0.1` | AWS Bedrock Converse provider |
| `@tardie/ai` | `0.0.2` | Shared deferred tool validation and response formats |
| `@tardie/ai-openai` | `4.0.0-rc.113-clavia.3` | OpenAI Responses provider |
| `@tardie/ai-anthropic` | `4.0.0-rc.113-clavia.2` | Anthropic provider |
| `@tardie/ai-openai-compat` | `4.0.0-rc.113-clavia.2` | OpenAI-compatible chat completions provider |

[CLAVIA_PATCHES.md](https://github.com/clavia-labs/effect/blob/clavia/ai-providers/CLAVIA_PATCHES.md) records each provider change and its upstream status. [CLAVIA_PUBLISHING.md](https://github.com/clavia-labs/effect/blob/clavia/ai-providers/CLAVIA_PUBLISHING.md) describes package publication.

Run `bun run gate --only=typecheck:model,typecheck:agent,test:model,test:agent` to check the Tardigrade integration. The Effect fork contains provider source checks and package publication checks.
