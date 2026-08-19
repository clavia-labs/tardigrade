# Publish

How to cut a release to npm.

## Packages

The published names are `@clavia/tardigrade` (the agent), `@clavia/tardigrade-core`, `@clavia/tardigrade-code`, `@clavia/tardigrade-host`, `@clavia/tardigrade-bun`, and `@clavia/tardigrade-model`. They ship TypeScript source and run on bun 1.3 or later.

## First version of a package

npm attaches a trusted publisher to a package that exists on the registry. Create the `@clavia` organization on npmjs.com (avatar menu, Add an Organization, free public-packages plan) and enable 2FA on the npm user. From a logged-in machine:

```bash
npm login
bun run tools/publish.ts
```

That packs with bun, so `workspace:*` rewrites to the version on the tarball, and uploads with npm. Scoped packages publish public (`publishConfig.access`).

On each new package at npmjs.com: Settings, Trusted publishing, GitHub Actions. Organization `clavia-labs`, repository `tardigrade`, workflow filename `publish.yml`, environment `npm`, allowed action `npm publish`. Create a GitHub environment named `npm` on `clavia-labs/tardigrade` (Settings, Environments). Required reviewers are optional.

## Tagged versions

Bump every package `version` to the same number, commit, and push a tag `v<version>`. The publish workflow runs the gate, packs, and publishes through GitHub OIDC. Re-running a tag skips versions that already exist on the registry.

A dry run is `bun run pack`, or workflow_dispatch with dry-run.
