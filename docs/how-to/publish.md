# Publish

How to publish RC and stable releases to npm.

## Packages

The published package is `@clavia/tardigrade`. It ships the agent and the `core`, `code`, `host`, `bun`, and `model` subpaths as TypeScript source. It runs on Bun 1.3 or later. The initial version is `0.0.1`.

## First version of a package

npm attaches a trusted publisher to a package that exists on the registry. Create the `@clavia` organization on npmjs.com (avatar menu, Add an Organization, free public-packages plan) and enable 2FA on the npm user. From a logged-in machine:

```bash
npm login
bun run tools/publish.ts
```

The command assembles the private workspaces into one tarball. It rewrites internal imports to package subpaths and combines external dependencies. npm publishes the package under the `latest` tag. Use `--tag <tag>` to select another npm tag. Use `--output <dir>` with `--dry-run` to keep a tarball for inspection.

On the package at npmjs.com: Settings, Trusted publishing, GitHub Actions. Organization `clavia-labs`, repository `tardigrade`, workflow filename `publish.yml`, environment `npm`, allowed action `npm publish`. Create a GitHub environment named `npm` on `clavia-labs/tardigrade` (Settings, Environments). Required reviewers are optional.

In the repository: Settings, Actions, General, allow GitHub Actions to create and approve pull requests.

## Release branches

`next` is the default integration branch. Engineers merge feature and fix PRs into `next`. Release Please uses `release-please-config.next.json` on this branch. Its release PR creates an RC version, a GitHub prerelease, and the npm tag `next`.

`main` is the stable branch. A promotion PR merges `next` into `main`. Merge the promotion PR with a merge commit to preserve release history. Release Please uses `release-please-config.json` on `main`. Its release PR removes the RC suffix and publishes the npm tag `latest`.

After a stable release, merge `main` into `next`. This merge gives the integration branch the stable manifest and changelog.

Conventional commit titles on merged PRs (`feat`, `fix`, `perf`, and a `BREAKING CHANGE` footer) determine the next version. Release Please updates `@clavia/tardigrade`, its changelog, and `.release-please-manifest.json`. `docs`, `chore`, `ci`, and `test` titles do not bump a version.

The `publish.yml` workflow runs on pushes to `next` and `main`. Merging a release PR tags `v<version>` and publishes through GitHub OIDC. A dry run is `bun run pack` or a manual workflow run with `dry-run`. A repeated run skips versions that exist on the registry.
