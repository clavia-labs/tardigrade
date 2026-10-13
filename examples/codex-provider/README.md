# Codex provider

Sign in with your ChatGPT account and make a single Codex request through Tardigrade's model interface. This example runs in Bun. For an interactive browser chat with tools and child agents, see [react-rlm-chat](../react-rlm-chat/README.md#run-with-codex-on-bun).

## Run

From the repository root:

```sh
bun install
cd examples/codex-provider
bun main.ts login
bun main.ts models
CODEX_MODEL=<id-from-models> bun main.ts ask "Say hello."
```

`login` saves private credentials to `.codex-credentials.json`. `models` lists the models available to your account. `ask` prints a response and exits, renewing and saving credentials when needed. Set `CODEX_CREDENTIALS_FILE` to use a different credential file.

## Use in your application

Provide a shared credentials layer with a callback that saves renewed tokens:

```ts
import { Layer } from "effect"
import { createProviderLayer } from "tardie/model/providers/codex"
import { codexOAuthLayer } from "tardie/model/providers/codex-auth"

const credentials = codexOAuthLayer({ tokens, persist: persistRotatedTokens })
const layer = createProviderLayer()({
  provider: "codex",
  client: {},
  model: { model: "<available-model-id>" }
}).pipe(Layer.provide(credentials))
```

`codexOAuthLayer` requires `HttpClient` and any services used by `persist`, then provides `CodexCredentials`. It accepts the overrides in `AUTH_DEFAULTS`, including `persistMs` for the persistence timeout. A failed or timed-out save retains the rotated tokens in memory and retries persistence on the next credentials request. Initial login remains explicit through `deviceLogin`.

The model layer supports `LanguageModel.generateText`, `streamText`, and `generateObject`. Share the credentials layer across model bindings for the same account so concurrent requests coordinate token renewal. See [credentials.ts](credentials.ts) for file persistence and [main.ts](main.ts) for login and model discovery.

Codex does not enforce output token limits. The provider warns and omits `max_output_tokens` by default. Use `createProviderLayer({ outputLimit: "reject" })` to reject requests that specify this limit.
