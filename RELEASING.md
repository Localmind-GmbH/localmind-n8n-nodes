# Releasing @localmind/n8n-nodes-localmind

For maintainers. The [README](README.md) is the package's page on npm and stays free of internal notes.

**Status:** the package exists on npm with an empty placeholder (0.0.1). The first release is 1.0.0; first finish the one-time setup in [Before the first release](#before-the-first-release).

## Versions

Versions follow [semantic versioning](https://semver.org/): a fix raises the patch number (1.0.1), a new feature the minor number (1.1.0), a breaking change the major number (2.0.0). A version on npm can never be changed or published again.

The workflow publishes only versions of the form X.Y.Z that are higher than the latest on npm. A prerelease (`1.1.0-rc.1`) or a fix for an older line (`1.0.1` after `1.1.0`) would need its own npm tag (`--tag next`), which the workflow does not set: raise the newest line instead.

## Release steps

Releases come only from GitHub Actions (`.github/workflows/publish.yml`), with npm provenance. They start by hand, from `main`, and need two approvals: a second maintainer approves the run on GitHub, and the workflow only **stages** the version on npm, where it goes live once a maintainer approves it with 2FA ([staged publishing](https://docs.npmjs.com/staged-publishing)).

1. **Test.** Run the [release suite](release-suite/) against Localmind (the newest release and the development version) and record the result in its table.
2. **Raise the version** in a pull request: `npm version <major|minor|patch> --no-git-tag-version` changes `package.json` and `package-lock.json`. In `CHANGELOG.md`, turn **Unreleased** into that version with today's date. Merge it after review.
3. **Dry run.** On GitHub: **Actions → Publish → Run workflow**, branch `main`, tick **Dry run**. It must end with "Dry run passed".
4. **Release.** Run the workflow again on `main`, without **Dry run**.
5. **Approve.** A second maintainer first rebuilds the release commit on their own machine, with Node.js 24 as in the workflow, and compares the file's SHA-256 with the one in the run's build summary:

   ```bash
   git checkout <commit of the run> && npm ci --ignore-scripts && npm run build
   npm pack --ignore-scripts && sha256sum localmind-n8n-nodes-localmind-<version>.tgz
   ```

   The build is reproducible, so the two must be equal. Only then they approve the run (**Review deployments**). The stage job then stages the version on npm.

6. **Approve on npm.** The stage job's summary names the stage ID. A maintainer with 2FA and publish rights checks that npm holds exactly the file the build job packed, then approves it (npm 11.15 or later, logged in with `npm login`):

   ```bash
   npm stage download <stage-id>
   sha256sum *-<stage-id>.tgz   # must be the SHA-256 in the build summary
   npm stage approve <stage-id>
   ```

   Or on npmjs.com: the package → **Staged Packages** → **Approve**. If anything is off, reject it instead (`npm stage reject <stage-id>`) and cancel the run on GitHub (**Cancel workflow**), or its github-release job waits five and a half hours for an approval that never comes. After an approval, the github-release job tags the commit and creates the GitHub release.

7. **Check** that npm shows the new version with provenance (`npm view @localmind/n8n-nodes-localmind --json`), and that the GitHub release has the file, its attestation and `SHA256SUMS`.

### What the workflow does

- **build** checks that the version is new and of the form X.Y.Z (no tag, not on npm, higher than the latest there), installs the dev tools without their install scripts, then tests, lints and builds, checks the package contents and packs the package. Its summary lists the file, its SHA-256 and its contents for the approver. It has no publishing rights, so the dev tools never see an npm token.
- **stage** installs nothing and runs only this repository's code. It checks the packed file again (its SHA-256, its `package.json` byte for byte against the repository's, its contents), checks right before staging that the tag is still free, and stages exactly that file with `npm stage publish`, through trusted publishing (OIDC), whose only allowed action is staging. Its summary names the stage ID and the commands to check and approve it. The packed file is kept for 30 days; if the approval on GitHub comes later, run the workflow again.
- **github-release** waits until the staged version is approved on npm (up to five and a half hours), then checks that npm serves that same file and lists no dependencies or install scripts for it, creates the tag (`v1.0.0`) through the API, which refuses a tag that exists, and creates a GitHub release with the file, a signed attestation and its SHA-256, for customers who install without npm access.

A **dry run** builds and checks the package exactly as a release would, then a `dry-run` job repeats the stage job's checks word for word and runs `npm stage publish --dry-run`. It needs no approval and holds no npm token, OIDC token or write access, so nothing is staged, published, tagged or released. A dry run may also start from a branch, for example to check a change to the workflow in its pull request. Do one before every release and after every change to `publish.yml`.

### If a run fails

If the approval on npm takes longer than the github-release job waits, approve it and then open the run and use **Re-run failed jobs**. A re-run of the github-release job only gets further once the version is approved on npm: before that, it waits again. Re-running works for any failure after staging: the stage job finds the version on npm from this very file and stops there, and the tag step accepts its own tag on this commit. A new run would stop with "already on npm". If a version was staged by mistake, reject it on npm; it never goes live.

## Before the first release

One-time steps, in this order.

### npm account

- **Organization.** The `@localmind` scope belongs to the npm organization `localmind`, converted from the former user account of that name. The release team are its members; require 2FA for all of them.
- **One owner: the company account.** The organization has one owner, a company account on a team mailbox. Since nobody could manage the package if that account were lost, it has two security keys (one kept by a second person or in the office safe), and its recovery codes are in the company password manager.
- **2FA by security key.** Protect the owner's account with 2FA by security key (WebAuthn), not an authenticator app, which a phishing page can relay.
- **Team mailbox.** npm lists every maintainer of a package publicly with name and email (`npm view @localmind/n8n-nodes-localmind maintainers`), so use npm accounts with a team email, not a personal one, where possible. Versions published by the workflow show GitHub Actions as their publisher. Give the company account a recovery email on a team mailbox that several people read, and make sure npm's publish notifications (an email to the owner on each publish) reach it, so that a publish nobody started is noticed.
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

npm trusted publishing can only be set up for a package that exists. The package is created without any token, by staging an empty shell once and approving it:

1. A member of the npm organization with publish rights and 2FA, on their own machine (npm 11.15 or later; check with `npm --version`, otherwise use `npx npm@11.19.1` in place of `npm`). First check which email that npm account uses (npmjs.com → Account → Email): npm will list it publicly as a maintainer of the package.

   ```bash
   mkdir n8n-nodes-shell && cd n8n-nodes-shell
   printf '{\n  "name": "@localmind/n8n-nodes-localmind",\n  "version": "0.0.1",\n  "description": "Placeholder. The package is published from github.com/Localmind-GmbH/localmind-n8n-nodes",\n  "license": "MIT"\n}\n' > package.json
   npm login
   npm stage publish --access public
   ```

   npm creates the package with its own public placeholder version, `0.0.0-stage`. The shell itself is only staged, not public yet.

2. Check that the staged shell holds only its `package.json` (`npm stage view <stage-id>`), then approve it: `npm stage approve <stage-id>`. Do not reject it: rejecting the package's first staged version may also remove the placeholder, and with it the package. Then `npm logout`, and delete the folder. `npm view @localmind/n8n-nodes-localmind versions` now shows `0.0.0-stage` and `0.0.1`, with `0.0.1` as `latest`.
3. A maintainer with 2FA, in the package's **Settings** on npmjs.com (the two sections save separately):
   - **Publishing access**: "Require two-factor authentication and disallow tokens", then **Update Package Settings**.
   - **Trusted Publisher** → GitHub Actions: organization `Localmind-GmbH`, repository `localmind-n8n-nodes`, workflow `publish.yml`, environment `npm-publish`. Under **Allowed actions**, leave `npm publish` and `npm dist-tag` unticked (`npm stage publish` is always allowed), then **Set up connection**. npm shows the connection as "Pending validation" until the workflow first uses it, which has to happen within 48 hours. The workflow can only stage once the repository is public, so check the connection on the day of the first release, right after going public; if its time ran out, delete it and set it up again with the same values.
4. Release 1.0.0 as in [Release steps](#release-steps). The workflow stages it through trusted publishing, with provenance and without any token, and it goes live with the approval on npm.
5. Deprecate the two placeholders, so that nobody installs them by mistake (with 2FA, from the shell's maintainer or the owner):

   ```bash
   npm deprecate @localmind/n8n-nodes-localmind@0.0.1 "Placeholder without code. Install 1.0.0 or later."
   npm deprecate @localmind/n8n-nodes-localmind@0.0.0-stage "Placeholder without code. Install 1.0.0 or later."
   ```

From then on, npm shows GitHub Actions as the publisher of every version.

## Reference

### Manual publishing

There is no `release` script: releases come only from the workflow, and the hand-written `CHANGELOG.md` is never rewritten from the commits. `prepublishOnly` stops an accidental `npm publish` or `npm stage publish` from a working copy, and `publishConfig.provenance` makes it fail outside GitHub Actions. That prevents mistakes, not misuse: anyone with publish rights on npm could still publish by hand without provenance. Check that every version shows provenance (`npm view @localmind/n8n-nodes-localmind --json`, `npm audit signatures`).

### Package check

`npm run check:package` (`scripts/check-package.mjs`) checks what the package contains, on every pull request and in the release's build job; the stage job runs it again on the unpacked file (`--unpacked`). It fails when the package contains:

- files other than `dist/`, `README.md`, `package.json` and a license
- keys or tokens, mentions of the internal code host, links of any scheme to hosts outside its allowlist or to GitHub outside this repository, ticket numbers, or email addresses other than support@localmind.ai
- local paths, IP addresses (IPv4 and IPv6), host names of internal networks (`.corp`, `.internal`, `.local`, …)
- in `package.json`: dependencies, install scripts, `bin` or native builds; in the stage job, any difference from the repository's `package.json`
- comments or editor metadata in SVGs, or source code in source maps

Extend its lists when needed. The pinned GitHub Actions are kept current by Dependabot (`.github/dependabot.yml`).

### Icons

`icons/localmind.svg` (light theme) and `icons/localmind.dark.svg` (dark theme) are the Localmind mark as vectors, from the favicon of localmind.ai: black and white, on a square canvas. Replace them when the mark changes.
