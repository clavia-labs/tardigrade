# React RLM chat

A small full-stack chat for trying Tardigrade agents and subagents. The server runs the durable actor. The web app is a static React site.

## Run it locally

You need [Bun](https://bun.sh/) and an [OpenRouter API key](https://openrouter.ai/settings/keys).

From the repository root, install the workspace dependencies:

```sh
bun install
```

Create `examples/react-rlm-chat/server/.env.local`:

```dotenv
OPENROUTER_API_KEY=your-key
```

Start the server and web app together:

```sh
bun run --cwd examples/react-rlm-chat dev
```

Open [http://localhost:5173](http://localhost:5173). The actor API runs at `http://localhost:4242`. Local actor data stays in `server/.tardigrade` between restarts.

## Deploy the server

### Cloudflare

Store the model credential, then deploy the Worker and Durable Objects:

```sh
cd examples/react-rlm-chat/server
bunx wrangler secret put OPENROUTER_API_KEY
bun run deploy:cloudflare
```

Wrangler prints the actor API URL after the deployment finishes.

### Celld

Choose the fleet bucket through `CELLD_BUCKET`, validate the bundle, then deploy it:

```sh
cd examples/react-rlm-chat/server
CELLD_BUCKET=s3://your-bucket celld deploy --config celld.jsonc --dry-run
CELLD_BUCKET=s3://your-bucket celld deploy --config celld.jsonc
```

Set `CELLD_VAR_OPENROUTER_API_KEY` on every Celld node. See the [Celld guide](../../docs/platforms/celld.mdx) for node and storage setup.

## Deploy the web app

Build the site with the deployed actor API URL:

```sh
cd examples/react-rlm-chat
VITE_API_URL=https://your-actor-api.example.com bun run --cwd web build
```

The static site is now in `web/dist`. Publish that directory with any static host. For Cloudflare Pages:

```sh
bunx wrangler pages deploy web/dist --project-name tardigrade-react-rlm-chat
```

`VITE_ACTOR_ID` selects an actor instance and defaults to `main`. Keep API keys out of `VITE_` variables because Vite includes them in the browser bundle.

The browser calls the actor API directly. Add authentication in front of the API before using this example as a public application.

## Project layout

- `server/actor.ts` defines the actor.
- `server/server.ts` starts the local Bun server.
- `server/worker.ts` starts the Cloudflare or Celld worker.
- `web/src/components` contains the chat interface.
