# Effect dependencies

The workspace installs published packages from the [Effect fork](https://github.com/clavia-labs/effect/tree/clavia/ai-providers). It has no local dependency patches.

| Package | Version | Purpose |
| --- | --- | --- |
| `effect` | `npm:@tardie/effect@4.0.0-rc.113` | Effect runtime with the upstream declaration fix |
| `@tardie/ai` | `0.0.1` | Shared deferred tool validation and response formats |
| `@tardie/ai-openai` | `4.0.0-rc.113-clavia.0` | OpenAI Responses provider |
| `@tardie/ai-anthropic` | `4.0.0-rc.113-clavia.0` | Anthropic provider |
| `@tardie/ai-openai-compat` | `4.0.0-rc.113-clavia.0` | OpenAI-compatible chat completions provider |

[CLAVIA_PATCHES.md](https://github.com/clavia-labs/effect/blob/clavia/ai-providers/CLAVIA_PATCHES.md) records each provider change and its upstream status. [CLAVIA_PUBLISHING.md](https://github.com/clavia-labs/effect/blob/clavia/ai-providers/CLAVIA_PUBLISHING.md) describes package publication.

Run `bun run gate --only=typecheck:model,test:model` to check the Tardigrade integration. The Effect fork contains provider source checks and package publication checks.
