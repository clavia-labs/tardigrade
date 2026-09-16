# React RLM chat

A small full-stack chat for trying Tardigrade agents and subagents. Cloudflare runs the actor API, serves the React site, and stores uploaded images and PDFs in R2. Thread inference reads the same bucket through a local SQLite cache.

## Run with Wrangler

Install workspace dependencies with `bun install`. Create `server/.dev.vars` with an OpenRouter key:

```dotenv
OPENROUTER_API_KEY=your-key
```

From the repository root:

```sh
bun run --cwd examples/react-rlm-chat dev:cloudflare
```

Open [http://localhost:8787](http://localhost:8787). Wrangler runs the Worker, Durable Objects, SQLite, and R2 locally. This command builds the web app before starting; restart it after web changes. Local data stays under `server/.wrangler/state`.

Use the attachment button to select images or PDFs. Uploads complete before the message is sent. The default per-file upload limit is 10 MB; set `CHAT_MAX_UPLOAD_BYTES` in `server/wrangler.jsonc` to change it. The composer shows the active limit. Objects larger than the SQLite cache admission limit remain in R2. Uploads persist even if you later remove them from a draft; this example has no garbage collection.

This example explicitly sets `authentication: "none"`. Anyone who can reach it can read conversations, call the model, and upload files. Keep it local or restrict the whole deployment with access controls before sharing it. Other Cloudflare apps require bearer authentication by default.

## Run the text-only Bun server

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

Create an R2 bucket and store the model credential:

```sh
cd examples/react-rlm-chat/server
bunx wrangler secret put OPENROUTER_API_KEY
bunx wrangler r2 bucket create tardigrade-react-rlm-chat-objects
```

Provision the catalog database if needed, add its returned `database_id` to the D1 binding in `wrangler.jsonc`, and apply the migration:

```sh
bunx wrangler d1 create tardigrade-react-rlm-chat-catalog
bunx wrangler d1 migrations apply CATALOG_DB --remote
bun run deploy:cloudflare
```

The deploy command builds and publishes the React assets with the Worker. Open the printed Worker URL. No separate Pages deployment is needed.

### Celld

The Celld configuration supports text chat. Choose the fleet bucket through `CELLD_BUCKET`, validate the bundle, then deploy it:

```sh
cd examples/react-rlm-chat/server
CELLD_BUCKET=s3://your-bucket celld deploy --config celld.jsonc --dry-run
CELLD_BUCKET=s3://your-bucket celld deploy --config celld.jsonc
```

Set `CELLD_VAR_OPENROUTER_API_KEY` on every Celld node. See the [Celld guide](../../docs/platforms/celld.mdx) for node and storage setup.

## Separate web hosting for Bun

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

The browser calls the actor API directly in this configuration. Add authentication in front of the API before using this example as a public application.

## Project layout

- `server/actor.ts` defines the actor.
- `server/server.ts` starts the local Bun server.
- `server/worker.ts` starts the Cloudflare or Celld worker.
- `server/uploads.ts` handles bounded image and PDF uploads.
- `web/src/components` contains the chat interface.
