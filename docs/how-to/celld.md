# Deploy to Celld

[Celld](https://celld.dev/docs) runs Wrangler Worker bundles and SQLite Durable Objects on a self-hosted fleet. `tdg init` creates `celld.jsonc` beside `wrangler.jsonc`. Both manifests use the same actor definition, Durable Object, alarm, and HTTP routes.

Install Celld and esbuild, then validate the project against a fleet bucket:

```bash
celld deploy --config celld.jsonc --bucket s3://actors --dry-run
```

Remove `--dry-run` to publish the deployment:

```bash
celld deploy --config celld.jsonc --bucket s3://actors
```

`celld.jsonc` is a stable Celld manifest, so Celld owns validation and deployment. `tdg setup` writes model connections to both platform manifests and keeps other Celld settings. Celld requires string Worker variables, so `TARDIGRADE_CONFIG` contains encoded JSON in this file.

Celld reads its bucket from `--bucket` or `CELLD_BUCKET`. Use `--endpoint` for an S3-compatible service and `--region` when the region cannot be inferred. Celld also supports `gs://` buckets through Google Application Default Credentials and `az://` containers through Azure credentials.

Every node needs the Worker Loader binding for Code Mode and the Worker variables that hold API credentials. Prefix an individual Worker variable with `CELLD_VAR_`, or point `CELLD_VARS_FILE` at a file containing the original variable names:

```bash
CELLD_WORKER_LOADER=LOADER \
CELLD_VAR_TARDIGRADE_TOKEN="$TARDIGRADE_TOKEN" \
CELLD_VAR_OPENAI_API_KEY="$OPENAI_API_KEY" \
celld \
  --bucket s3://actors \
  --listen 0.0.0.0:8080 \
  --internal-listen 10.0.0.12:8081 \
  --advertise 10.0.0.12:8081
```

Keep the internal listener on a trusted private network. A deployment is loaded when a node starts, so restart nodes through the fleet rollout procedure after publishing a new version.

The generated Celld manifest selects the `replay` sandbox transport and assigns background tasks to the `request`. A loaded Worker returns package-call boundaries as JSON, and the actor host reruns the deterministic body with each recorded result. Request ownership registers reconciliation with `waitUntil`, so Celld keeps it alive after the Durable Object RPC returns. Cloudflare uses direct capability transport and assigns background tasks to the `host` by default. See Celld's [Cloudflare compatibility](https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md) and [operations documentation](https://github.com/denoland/celld/blob/main/docs/README.md) for its current platform surface.
