# Codex provider

Use `tardie/model/providers/codex` to call Codex directly through the existing model provider interface. The provider supports `LanguageModel.streamText`, `generateText`, and `generateObject` through the Responses stream decoder. The example runs in Bun. The provider and authentication modules use portable Effect services and have no filesystem or server dependency.

## Run

From this directory, run:

```sh
bun install
bun main.ts login
bun main.ts models
CODEX_MODEL=<available-model-id> bun main.ts ask "Say hello."
```

`models` lists the model IDs available to the signed-in account, excluding entries marked hidden by the server. Use one of these IDs for `CODEX_MODEL`. Model access changes over time; an older model ID can return HTTP 400. `CODEX_CLIENT_VERSION` and `CODEX_MODEL_LIST_MS` override the discovery version and timeout from `MODEL_LIST_DEFAULTS`.

`login` saves tokens to `.codex-credentials.json` with mode `0600`. `CODEX_CREDENTIALS_FILE` overrides the path. `ask` reads that file and saves rotated tokens after renewal. Keep the file private. A failed write can leave a `.tmp` file; remove that file before repeating login.

For a research actor with code execution, workspace files, and delegated agents, use the [Codex chat instructions](../react-rlm-chat/README.md#run-with-codex-on-bun).

## Integrate

```ts
import { createProviderLayer } from "tardie/model/providers/codex"
import { credentialsFromTokens } from "tardie/model/providers/codex-auth"

const auth = yield* credentialsFromTokens(tokens, {}, persistRotatedTokens)
const providerLayer = createProviderLayer(auth)
const layer = providerLayer({
  provider: "codex",
  client: {},
  model: { model: "<available-model-id>" }
})
```

Construct the credentials service once per account and share it across bindings. It serializes token renewal. Supply a persistence callback to retain rotated tokens across process restarts. Interactive device login is explicit and never runs during provider construction. `AUTH_DEFAULTS` exports authentication limits; `deviceLogin` and `credentialsFromTokens` accept overrides.

The default `providerLayer` accepts a Codex access token as `client.apiKey`. It reads the account routing claim from that token. It does not renew static tokens. `tdg setup` recognizes provider `codex`, uses protocol `openai-responses`, and generates the Codex provider import. Supply the access token through the configured secret environment variable. For automatic renewal, replace that registry entry with `createProviderLayer(auth)` from a host-owned credentials service.

`DEFAULT_BASE_URL` names the Codex endpoint. Override it through `client.apiUrl`. Ordinary model request timeout and retry settings remain available through the model binding. The provider forces `store: false` and moves leading system messages into `instructions`. It preserves tool calls and reasoning items through the OpenAI Responses adapter.

Codex does not enforce `max_output_tokens`. `DEFAULT_OUTPUT_LIMIT` is `"warn"`: the provider reports the requested value before omitting it. Model binding settings expose `outputTokenLimitEnforcement: "unsupported"`. Pass `{ outputLimit: "reject" }` as the second argument to `createProviderLayer` to reject requests that specify this limit. This policy does not impose a token ceiling through prompt instructions.
