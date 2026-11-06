# Releasing @localmind/n8n-nodes-localmind

For maintainers. The [README](README.md) is the package's page on npm and stays free of internal notes.

**Status:** not published yet. The first release is 1.0.0.

## Release steps

Releases are published by GitHub Actions (`.github/workflows/publish.yml`) with npm provenance. They start by hand, from `main` only, and need a second maintainer's approval. The version follows [semantic versioning](https://semver.org/): a fix raises the patch number (1.0.1), a new feature the minor number (1.1.0), a breaking change the major number (2.0.0). A version on npm can never be changed or published again.

1. Run the [release suite](release-suite/) against Localmind and record the result.
2. In a pull request: raise the version with `npm version <major|minor|patch> --no-git-tag-version` (changes `package.json` and `package-lock.json`), and turn **Unreleased** in `CHANGELOG.md` into that version with today's date. Merge it after review.
3. On GitHub: **Actions → Publish → Run workflow**, branch `main`.
4. A second maintainer opens the run and approves it (**Review deployments**). The workflow then:
   - **build** checks that the version is new and of the form X.Y.Z (no tag, not on npm, higher than the latest there), then tests, lints and builds, checks the package contents and packs the package. It has no publishing rights, so the dev tools it installs never see an npm token.
   - **publish** publishes exactly the packed file, checked by its SHA-256. It installs nothing. The packed file is kept for 30 days; if the approval comes later, run the workflow again.
   - **github-release** checks that npm serves that same file, tags the commit (`v1.0.0`) and creates a GitHub release with the file, a signed attestation and its SHA-256, for customers who install without npm access.

If only the last job (tag and GitHub release) fails, npm already has the version: open that run and use **Re-run failed jobs**. A new run would stop with "already on npm".

The workflow publishes only versions of the form X.Y.Z that are higher than the latest on npm. A prerelease (`1.1.0-rc.1`) or a fix for an older line (`1.0.1` after `1.1.0`) needs its own npm tag (`--tag next`), which the workflow does not set: raise the newest line instead.

There is no `release` script: releases come only from the workflow, and the hand-written `CHANGELOG.md` is never rewritten from the commits. An `npm publish` from a working copy is refused with a pointer to the workflow.

## Before the first publish

One-time steps:

- **First publish.** npm trusted publishing can only be set up for a package that exists, so 1.0.0 is published with a granular npm token, in this order:
  1. Make sure the GitHub settings below are active, the environment's required reviewers included (on the Free plan they need the public repository).
  2. Create the token with publish rights for this package only and an expiry of a day or two. Add it **only** as the secret `NPM_TOKEN` of the `npm-publish` environment, never as a repository secret.
  3. Start the release as described above; the publish workflow uses the token when it is set.
  4. Right after it: add the trusted publisher on npmjs.com (this repository, workflow `publish.yml`, environment `npm-publish`), delete the secret, revoke the token, and set the package's publishing access to "Require two-factor authentication and disallow tokens".
- **Manual publishing.** `prepublishOnly` stops an accidental `npm publish` from a working copy, and `publishConfig.provenance` makes it fail outside GitHub Actions. That prevents mistakes, not misuse: anyone with publish rights on npm could still publish by hand without provenance. Keep publish rights on npm to a small release team, and check that every version shows provenance (`npm view @localmind/n8n-nodes-localmind --json`, `npm audit signatures`).
- **Publisher account.** npm shows the name and email of the account that publishes in the package's public data. Publish from a company npm account with a team email, not a personal one. Protect it with 2FA by security key or authenticator app, give the `@localmind` org at least two owners, and require 2FA for all its members.
- **GitHub settings.** Set these up before the first release (`publish.yml` describes them too):
  - Environment `npm-publish`: required reviewers, "Prevent self-review", no administrator bypass, deployment branches limited to `main`.
  - A tag ruleset for `v*.*.*`: restrict updates and deletions, block force pushes. Creations stay allowed: the workflow creates the tags, and a tag starts nothing.
  - Release immutability (Settings → General → Releases), so a published release and its files cannot be changed.
  - A ruleset for `main`: changes only through pull requests with a review and a passing CI check, no force pushes.
  - 2FA required for the GitHub organization, and few maintainers.
  - Before making it public: everything the repository ever held becomes visible. Check that it has only `main` (no other branches, tags or pull requests) and delete old Actions runs and their artifacts. Push only from a clone whose history starts at the public first commit; the internal Bitbucket history must never reach GitHub.
  - The repository public before the first release: npm provenance and GitHub's build attestations need a public repository. `repository.url` in `package.json` names it, and npm provenance requires the two to match. The README links the customer guide in that repository, and `check:package` allows GitHub links only into it, so a new name changes all three.
  - On GitHub's Free plan, rulesets and the environment's required reviewers take effect only in a public repository. Right after making it public: add the reviewers to `npm-publish` (with "Prevent self-review", without administrator bypass), and turn on private vulnerability reporting (which `SECURITY.md` points to), secret scanning with push protection and CodeQL's default setup under Settings → Advanced Security.
- **README.** Before publishing, check that it holds nothing internal (ticket numbers, status notes, internal links).
- **Package contents.** `npm run check:package` (`scripts/check-package.mjs`) checks them on every pull request and right before every publish. It fails when the package contains:
  - files other than `dist/`, `README.md`, `package.json` and a license
  - keys or tokens, mentions of Bitbucket, links of any scheme to hosts outside its allowlist or to GitHub outside this repository, ticket numbers, or email addresses other than support@localmind.ai
  - local paths or IP addresses
  - comments or editor metadata in SVGs, or source code in source maps

  Extend its lists when needed. The pinned GitHub Actions are kept current by Dependabot (`.github/dependabot.yml`).

- **Icons.** `icons/localmind.svg` and `icons/localmind.dark.svg` are a placeholder (a PNG inside an SVG, identical for light and dark). n8n's verified listing expects real vector icons.
