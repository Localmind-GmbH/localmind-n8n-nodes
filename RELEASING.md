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
   - **publish** installs nothing and runs only this repository's code. It checks the packed file again: its SHA-256, its `package.json` byte for byte against the repository's (name, version, no install scripts, no dependencies), and its contents with the package check. Then it publishes exactly that file. The packed file is kept for 30 days; if the approval comes later, run the workflow again. The build job's summary lists the file, its SHA-256 and its contents for the approver.
   - **github-release** checks that npm serves that same file and lists no dependencies or install scripts for it, tags the commit (`v1.0.0`) through the API, which refuses a tag that exists, and creates a GitHub release with the file, a signed attestation and its SHA-256, for customers who install without npm access.

If a run fails after publishing (in the publish job or the last one), open that run and use **Re-run failed jobs**: publish finds the version on npm from this very file and stops there, and the tag step accepts its own tag on this commit. A new run would stop with "already on npm".

The workflow publishes only versions of the form X.Y.Z that are higher than the latest on npm. A prerelease (`1.1.0-rc.1`) or a fix for an older line (`1.0.1` after `1.1.0`) needs its own npm tag (`--tag next`), which the workflow does not set: raise the newest line instead.

There is no `release` script: releases come only from the workflow, and the hand-written `CHANGELOG.md` is never rewritten from the commits. An `npm publish` from a working copy is refused with a pointer to the workflow.

## Before the first publish

One-time steps:

- **First publish.** npm trusted publishing can only be set up for a package that exists, so 1.0.0 is published with a granular npm token, in this order:
  1. Make sure the GitHub settings below are active, the environment's required reviewers included (on the Free plan they need the public repository).
  2. Create a granular token with publish rights and an expiry of a day or two. For a package that does not exist yet, npm may offer only the whole `@localmind` scope; the publish job therefore checks that the file it publishes is this package. Add the token **only** as the secret `NPM_FIRST_PUBLISH_TOKEN` of the `npm-publish` environment, never as a repository secret.
  3. Start the release as described above; the publish job uses the token, with a warning, and refuses it once the package exists.
  - Safer alternative, for the maintainers to decide: publish a placeholder version (for example `0.0.1`, a README only) by hand from the company account with 2FA, set up trusted publishing for it, and publish 1.0.0 without any token. The placeholder stays visible on npm (deprecate it).
  4. Right after it: add the trusted publisher on npmjs.com (this repository, workflow `publish.yml`, environment `npm-publish`), delete the secret, revoke the token, and set the package's publishing access to "Require two-factor authentication and disallow tokens".
- **Manual publishing.** `prepublishOnly` stops an accidental `npm publish` from a working copy, and `publishConfig.provenance` makes it fail outside GitHub Actions. That prevents mistakes, not misuse: anyone with publish rights on npm could still publish by hand without provenance. Keep publish rights on npm to a small release team, and check that every version shows provenance (`npm view @localmind/n8n-nodes-localmind --json`, `npm audit signatures`).
- **Publisher account.** npm shows the name and email of the account that publishes in the package's public data. Publish from a company npm account with a team email, not a personal one. The `@localmind` scope belongs to the npm user account "localmind" today: convert it into an npm organization (npmjs.com → the account → Convert to organization), give it at least two owners, and require 2FA for all members. Protect the owners' accounts with 2FA by security key (WebAuthn), not an authenticator app, which a phishing page can relay. Give the account a recovery email on a team mailbox that several people read, and make sure publish notifications (npm emails every owner on each publish) reach it, so that a publish nobody started is noticed.
- **GitHub settings.** Set these up before the first release (`publish.yml` describes them too):
  - Environment `npm-publish`: required reviewers, "Prevent self-review", no administrator bypass, deployment branches limited to the branch `main`, with no tag rule. Older commits still hold versions of this workflow that a `v*` tag starts; only this rule keeps them from publishing.
  - A tag ruleset for `v*.*.*`: restrict updates and deletions, block force pushes. Creations stay allowed: the workflow creates the tags.
  - Actions (Settings → Actions → General): allow only actions created by GitHub (all the workflows use, `actions/*`), pinned to a full commit SHA; workflow permissions "Read repository contents"; GitHub Actions may not create or approve pull requests; workflows from outside contributors need approval.
  - Release immutability (Settings → General → Releases), so a published release and its files cannot be changed.
  - A ruleset for `main`, without bypass: changes only through pull requests with one approval, stale approvals dismissed on new commits, approval of the most recent push required (so the last pusher cannot approve their own change), the CI workflow's `check` job required with GitHub Actions as its source (so no other app can report it), no force pushes, no deletion.
  - 2FA required for the GitHub organization; at most two administrators of the repository; write access only for the few people who maintain it, not for whole teams.
  - Dependabot alerts and security updates on (Settings → Advanced Security).
  - Before making it public: everything the repository ever held becomes visible. Check that it has only `main` (no other branches, tags or pull requests) and delete old Actions runs and their artifacts. Push only from a clone whose history starts at the public first commit; the internal history from before must never reach GitHub.
  - The repository public before the first release: npm provenance and GitHub's build attestations need a public repository. `repository.url` in `package.json` names it, and npm provenance requires the two to match. The README links the customer guide in that repository, and `check:package` allows GitHub links only into it, so a new name changes all three.
  - On GitHub's Free plan, rulesets and the environment's required reviewers take effect only in a public repository. Right after making it public: add the reviewers to `npm-publish` (with "Prevent self-review", without administrator bypass), and turn on private vulnerability reporting (which `SECURITY.md` points to), secret scanning with push protection and CodeQL's default setup under Settings → Advanced Security.
- **README.** Before publishing, check that it holds nothing internal (ticket numbers, status notes, internal links).
- **Package contents.** `npm run check:package` (`scripts/check-package.mjs`) checks them on every pull request and in the release's build job; the publish job runs it again on the unpacked file (`--unpacked`). It fails when the package contains:
  - files other than `dist/`, `README.md`, `package.json` and a license
  - keys or tokens, mentions of the internal code host, links of any scheme to hosts outside its allowlist or to GitHub outside this repository, ticket numbers, or email addresses other than support@localmind.ai
  - local paths, IP addresses (IPv4 and IPv6), host names of internal networks (`.corp`, `.internal`, `.local`, …)
  - in `package.json`: dependencies, install scripts, `bin` or native builds; in the publish job, any difference from the repository's `package.json`
  - comments or editor metadata in SVGs, or source code in source maps

  Extend its lists when needed. The pinned GitHub Actions are kept current by Dependabot (`.github/dependabot.yml`).

- **Icons.** `icons/localmind.svg` (light theme) and `icons/localmind.dark.svg` (dark theme) are the Localmind mark as vectors, from the favicon of localmind.ai: black and white, on a square canvas. Replace them when the mark changes.
