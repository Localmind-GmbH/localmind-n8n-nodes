# Releasing @localmind/n8n-nodes-localmind

For maintainers. The [README](README.md) is the package's page on npm and stays free of internal notes.

**Status:** not published yet. The first release is 1.0.0; first do the one-time setup in [Before the first release](#before-the-first-release).

## Versions

Versions follow [semantic versioning](https://semver.org/): a fix raises the patch number (1.0.1), a new feature the minor number (1.1.0), a breaking change the major number (2.0.0). A version on npm can never be changed or published again.

The workflow publishes only versions of the form X.Y.Z that are higher than the latest on npm. A prerelease (`1.1.0-rc.1`) or a fix for an older line (`1.0.1` after `1.1.0`) would need its own npm tag (`--tag next`), which the workflow does not set: raise the newest line instead.

## Release steps

Releases are published only by GitHub Actions (`.github/workflows/publish.yml`), with npm provenance. They start by hand, from `main`, and need a second maintainer's approval.

1. **Test.** Run the [release suite](release-suite/) against Localmind (the newest release and the development version) and record the result in its table.
2. **Raise the version** in a pull request: `npm version <major|minor|patch> --no-git-tag-version` changes `package.json` and `package-lock.json`. In `CHANGELOG.md`, turn **Unreleased** into that version with today's date. Merge it after review.
3. **Dry run.** On GitHub: **Actions → Publish → Run workflow**, branch `main`, tick **Dry run**. It must end with "Dry run passed".
4. **Release.** Run the workflow again on `main`, without **Dry run**.
5. **Approve.** A second maintainer first rebuilds the release commit on their own machine, with Node.js 24 as in the workflow, and compares the file's SHA-256 with the one in the run's build summary:

   ```bash
   git checkout <commit of the run> && npm ci --ignore-scripts && npm run build
   npm pack --ignore-scripts && sha256sum localmind-n8n-nodes-localmind-<version>.tgz
   ```

   The build is reproducible, so the two must be equal. Only then they approve the run (**Review deployments**).

6. **Check** that npm shows the new version with provenance (`npm view @localmind/n8n-nodes-localmind --json`), and that the GitHub release has the file, its attestation and `SHA256SUMS`.

### What the workflow does

- **build** checks that the version is new and of the form X.Y.Z (no tag, not on npm, higher than the latest there), installs the dev tools without their install scripts, then tests, lints and builds, checks the package contents and packs the package. Its summary lists the file, its SHA-256 and its contents for the approver. It has no publishing rights, so the dev tools never see an npm token.
- **publish** installs nothing and runs only this repository's code. It checks the packed file again (its SHA-256, its `package.json` byte for byte against the repository's, its contents), checks right before publishing that the tag is still free, and publishes exactly that file. The packed file is kept for 30 days; if the approval comes later, run the workflow again.
- **github-release** checks that npm serves that same file and lists no dependencies or install scripts for it, creates the tag (`v1.0.0`) through the API, which refuses a tag that exists, and creates a GitHub release with the file, a signed attestation and its SHA-256, for customers who install without npm access.

A **dry run** builds and checks the package exactly as a release would, then a `dry-run` job repeats the publish job's checks word for word and runs `npm publish --dry-run`. It needs no approval and holds no npm token, OIDC token or write access, so nothing is published, tagged or released. A dry run may also start from a branch, for example to check a change to the workflow in its pull request. Do one before every release and after every change to `publish.yml`.

### If a run fails

If a run fails after publishing (in the publish job or the last one), open that run and use **Re-run failed jobs**: publish finds the version on npm from this very file and stops there, and the tag step accepts its own tag on this commit. A new run would stop with "already on npm".

## Before the first release

One-time steps, in this order.

### npm account

- **Organization.** The `@localmind` scope belongs to the npm user account "localmind" today. Convert it into an npm organization (npmjs.com → the account → Convert to organization) and require 2FA for all members.
- **One owner: the company account.** The organization has one owner, a company account on a team mailbox. Since nobody could manage the package if that account were lost, it has two security keys (one kept by a second person or in the office safe), and its recovery codes are in the company password manager.
- **2FA by security key.** Protect the owner's account with 2FA by security key (WebAuthn), not an authenticator app, which a phishing page can relay.
- **Team mailbox.** npm shows the name and email of the account that publishes in the package's public data, so publish from a company account with a team email, not a personal one. Give the account a recovery email on a team mailbox that several people read, and make sure npm's publish notifications (an email to the owner on each publish) reach it, so that a publish nobody started is noticed.
- **Few publishers.** Keep publish rights on npm to a small release team.

### GitHub settings

Set these up before the first release; `publish.yml` describes them too.

- **Environment `npm-publish`:** required reviewers, "Prevent self-review", no administrator bypass, deployment branches limited to the branch `main`, with no tag rule. Older commits still hold versions of this workflow that a `v*` tag starts; only this rule keeps them from publishing.
- **Tag ruleset for `v*.*.*`:** restrict updates and deletions, block force pushes. Creations stay allowed, since the workflow creates the tags.
- **Ruleset for `main`, without bypass:** changes only through pull requests with one approval, stale approvals dismissed on new commits, approval of the most recent push required (so the last pusher cannot approve their own change), the CI workflow's `check` job required with GitHub Actions as its source (so no other app can report it), no force pushes, no deletion.
- **Actions (Settings → Actions → General):** allow only actions created by GitHub (all the workflows use `actions/*`), pinned to a full commit SHA; workflow permissions "Read repository contents"; GitHub Actions may not create or approve pull requests; workflows from outside contributors need approval.
- **Release immutability** (Settings → General → Releases), so a published release and its files cannot be changed.
- **Organization:** 2FA required; at most two administrators of the repository; write access only for the few people who maintain it, not for whole teams.
- **Advanced Security:** Dependabot alerts and security updates, private vulnerability reporting (which `SECURITY.md` points to), secret scanning with push protection, and CodeQL's default setup.

On GitHub's Free plan, rulesets and the environment's required reviewers take effect only in a public repository. Check them again right after making it public.

### Going public

npm provenance and GitHub's build attestations need a public repository, so it goes public before the first release. Everything the repository ever held becomes visible:

- Check that it has only `main`: no other branches, tags or pull requests.
- Delete old Actions runs and their artifacts.
- Push only from a clone whose history starts at the public first commit; the internal history from before must never reach GitHub.
- `repository.url` in `package.json` names the repository, and npm provenance requires the two to match. The README links the customer guide in that repository, and `check:package` allows GitHub links only into it, so a new name changes all three.
- Check that the README holds nothing internal: ticket numbers, status notes, internal links.

### First publish

npm trusted publishing can only be set up for a package that exists. Two ways to publish 1.0.0:

- **With a short-lived token:**
  1. Make sure the GitHub settings above are active, the environment's required reviewers included.
  2. Create a granular npm token with publish rights and an expiry of a day or two. For a package that does not exist yet, npm may offer only the whole `@localmind` scope; the publish job therefore checks that the file it publishes is this package. Add the token **only** as the secret `NPM_FIRST_PUBLISH_TOKEN` of the `npm-publish` environment, never as a repository secret.
  3. Release as described in [Release steps](#release-steps). The publish job uses the token, with a warning, and refuses it once the package exists.
- **Without any token (safer):** publish a placeholder version (for example `0.0.1`, a README only) by hand from the company account with 2FA, set up trusted publishing for it, and publish 1.0.0 through the workflow. The placeholder stays visible on npm; deprecate it.

Right after the first publish: add the trusted publisher on npmjs.com (this repository, workflow `publish.yml`, environment `npm-publish`), delete the secret and revoke the token if one was used, and set the package's publishing access to "Require two-factor authentication and disallow tokens".

## Reference

### Manual publishing

There is no `release` script: releases come only from the workflow, and the hand-written `CHANGELOG.md` is never rewritten from the commits. `prepublishOnly` stops an accidental `npm publish` from a working copy, and `publishConfig.provenance` makes it fail outside GitHub Actions. That prevents mistakes, not misuse: anyone with publish rights on npm could still publish by hand without provenance. Check that every version shows provenance (`npm view @localmind/n8n-nodes-localmind --json`, `npm audit signatures`).

### Package check

`npm run check:package` (`scripts/check-package.mjs`) checks what the package contains, on every pull request and in the release's build job; the publish job runs it again on the unpacked file (`--unpacked`). It fails when the package contains:

- files other than `dist/`, `README.md`, `package.json` and a license
- keys or tokens, mentions of the internal code host, links of any scheme to hosts outside its allowlist or to GitHub outside this repository, ticket numbers, or email addresses other than support@localmind.ai
- local paths, IP addresses (IPv4 and IPv6), host names of internal networks (`.corp`, `.internal`, `.local`, …)
- in `package.json`: dependencies, install scripts, `bin` or native builds; in the publish job, any difference from the repository's `package.json`
- comments or editor metadata in SVGs, or source code in source maps

Extend its lists when needed. The pinned GitHub Actions are kept current by Dependabot (`.github/dependabot.yml`).

### Icons

`icons/localmind.svg` (light theme) and `icons/localmind.dark.svg` (dark theme) are the Localmind mark as vectors, from the favicon of localmind.ai: black and white, on a square canvas. Replace them when the mark changes.
