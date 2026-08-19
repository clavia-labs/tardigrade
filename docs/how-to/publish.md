# Publish

How to cut a release to npm.

## Packages

The published names are `@clavia/tardigrade` (the agent), `@clavia/tardigrade-core`, `@clavia/tardigrade-code`, `@clavia/tardigrade-host`, `@clavia/tardigrade-bun`, and `@clavia/tardigrade-model`. They ship TypeScript source and run on bun 1.3 or later. All six share one version.

## First version of a package

npm attaches a trusted publisher to a package that exists on the registry. Create the `@clavia` organization on npmjs.com (avatar menu, Add an Organization, free public-packages plan) and enable 2FA on the npm user. From a logged-in machine:

```bash
npm login
bun run tools/publish.ts
```

That packs with bun, so `workspace:*` rewrites to the version on the tarball, and uploads with npm. Scoped packages publish public (`publishConfig.access`).

On each new package at npmjs.com: Settings, Trusted publishing, GitHub Actions. Organization `clavia-labs`, repository `tardigrade`, workflow filename `publish.yml`, environment `npm`, allowed action `npm publish`. Create a GitHub environment named `npm` on `clavia-labs/tardigrade` (Settings, Environments). Required reviewers are optional.

In the repository: Settings, Actions, General, allow GitHub Actions to create and approve pull requests.

## Release Please

A push to `main` runs [release-please](https://github.com/googleapis/release-please). Conventional commit titles on squash-merged PRs (`feat`, `fix`, `perf`, and a `BREAKING CHANGE` footer) accumulate on a release PR that bumps every package together, writes each package `CHANGELOG.md`, and updates `.release-please-manifest.json`. Merging that PR tags `v<version>` and the same workflow run publishes through GitHub OIDC.

`docs`, `chore`, `ci`, and `test` titles do not bump a version. A dry run is `bun run pack`, or workflow_dispatch with dry-run. Re-running skips versions that already exist on the registry.
