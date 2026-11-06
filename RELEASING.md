# Releasing @localmind/n8n-nodes-localmind

For maintainers. The [README](README.md) is the package's page on npm and stays free of internal notes.

**Status:** not published yet. The first release is 1.0.0.

## Release steps

Releases are published by GitHub Actions (`.github/workflows/publish.yml`) with npm provenance, from a version tag:

1. Run the [release suite](release-suite/) against Localmind and record the result.
2. In `CHANGELOG.md`, turn **Unreleased** into the new version with today's date.
3. `npm version <major|minor|patch> -m "Release %s"` bumps the version, commits and tags.
4. `git push --follow-tags`. The tag starts the workflow. After a second maintainer approves it, the workflow tests, lints and builds, checks the package contents and publishes. It then attaches the published package with a signed attestation and its SHA-256 to a GitHub release, for customers who install without npm access.

Do not run `npm run release` on your machine: there it runs release-it with auto-changelog, which rewrites the hand-written `CHANGELOG.md` from the commits. In GitHub Actions the same command only lints, builds and publishes.

## Before the first publish

One-time steps:

- **First publish.** npm trusted publishing can only be set up for a package that exists. Publish 1.0.0 with a granular npm token with a short expiry: add it as the secret `NPM_TOKEN` of the `npm-publish` environment and push the tag; the publish workflow uses it when it is set. Then add the trusted publisher on npmjs.com (this repository, workflow `publish.yml`, environment `npm-publish`), delete the secret, revoke the token, and set the package's publishing access to "Require two-factor authentication and disallow tokens". A manual `npm publish` does not work: `publishConfig.provenance` requires GitHub Actions, and the package's `prepublishOnly` check stops it unless `RELEASE_MODE=true` is set.
- **Publisher account.** npm shows the name and email of the account that publishes in the package's public data. Publish from a company npm account with a team email, not a personal one. Protect it with 2FA by security key or authenticator app, give the `@localmind` org at least two owners, and require 2FA for all its members.
- **GitHub settings.** Set these up before the first tag (`publish.yml` describes them too):
  - Environment `npm-publish`: required reviewers, "Prevent self-review", deployment tags limited to `v*.*.*`.
  - A tag ruleset for `v*.*.*`: only maintainers may create, update or delete version tags.
  - A ruleset for `main`: changes only through pull requests with a review and a passing CI check, no force pushes.
  - 2FA required for the GitHub organization, and few maintainers.
  - The repository public before the first tag: npm provenance and GitHub's build attestations need a public repository. `repository.url` in `package.json` names it, and npm provenance requires the two to match. The README links the customer guide in that repository, and `check:package` allows GitHub links only into it, so a new name changes all three.
  - On GitHub's Free plan, rulesets and the environment's required reviewers take effect only in a public repository. Right after making it public: add the reviewers to `npm-publish` (with "Prevent self-review", without administrator bypass), and turn on private vulnerability reporting (which `SECURITY.md` points to), secret scanning with push protection and CodeQL's default setup under Settings → Advanced Security.
- **README.** Before publishing, check that it holds nothing internal (ticket numbers, status notes, internal links).
- **Package contents.** `npm run check:package` (`scripts/check-package.mjs`) checks them on every pull request and right before every publish. It fails when the package contains:
  - files other than `dist/`, `README.md`, `package.json` and a license
  - keys or tokens, mentions of Bitbucket, links of any scheme to hosts outside its allowlist or to GitHub outside this repository, ticket numbers, or email addresses other than support@localmind.ai
  - local paths or IP addresses
  - comments or editor metadata in SVGs, or source code in source maps

  Extend its lists when needed. The pinned GitHub Actions are kept current by Dependabot (`.github/dependabot.yml`).

- **Icons.** `icons/localmind.svg` and `icons/localmind.dark.svg` are a placeholder (a PNG inside an SVG, identical for light and dark). n8n's verified listing expects real vector icons.
