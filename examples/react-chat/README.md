# React chat

This example pairs a deployable Tardigrade actor with a static React application. The server owns the actor, model configuration, durable storage adapters, and platform manifests. The web package owns the browser client and user interface.

## Structure

- `server/` contains the actor definition, local server project, Cloudflare Worker entry, Celld manifest, model lock, and catalog migration.
- `web/` contains the Vite application and focused React components.
- The root package starts both workspace packages for local development.

## Run locally

Add `OPENROUTER_API_KEY` to `server/.env.local`, then run this command from the repository root:

```sh
bun run --cwd examples/react-chat dev
```

Open `http://localhost:5173`. The web app connects to the actor API at `http://localhost:4242`.

`server/server.ts` reads the visible project configuration, mounts the actor, binds the model catalog and durable thread host, and starts the HTTP application. Local development does not invoke the Tardigrade CLI.

## Configure the web deployment

`VITE_API_URL` selects the deployed actor API. `VITE_ACTOR_ID` selects the actor instance and defaults to `main`. Both values are resolved during the web build.

```sh
VITE_API_URL=https://actors.example.com bun run --cwd examples/react-chat/web build
```

Publish `web/dist` with a static host. Keep provider credentials and service tokens out of Vite environment variables because Vite includes them in the browser bundle.

## Deploy the server

The server package follows the project shape created by `tdg init`. Store the provider credential with the deployment platform before publishing.

For Cloudflare:

```sh
cd examples/react-chat/server
bunx wrangler secret put OPENROUTER_API_KEY
bun run deploy:cloudflare
```

For Celld:

```sh
cd examples/react-chat/server
celld deploy --config celld.jsonc --dry-run
celld deploy --config celld.jsonc
```

The browser calls the actor API directly. A production application should place its user authentication and authorization boundary in front of the actor API.
