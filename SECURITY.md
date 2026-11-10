# Security policy

## Supported versions

Security fixes go into the latest released version of `@localmind/n8n-nodes-localmind`. Update to it to receive them.

## Reporting a vulnerability

Please do not report security problems in a public issue, discussion or pull request.

Report them privately through GitHub instead: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/Localmind-GmbH/localmind-n8n-nodes/security/advisories/new)). Only you and the maintainers can see the report. If you cannot use GitHub, write to support@localmind.ai instead.

Helpful to include:

- the package version, the n8n version and, if you know it, the Localmind version
- the steps to reproduce the problem, and what an attacker could do with it

Never include real API keys, passwords or customer data. If a key may have been exposed, deactivate it in Localmind and create a new one.

We confirm receipt within 5 working days and keep you informed until the problem is fixed. The fix comes as a new version together with a GitHub security advisory. Tell us if you would like to be credited.

## Scope

This policy covers the code in this repository: the nodes, the credential, and the build and release workflows.

- Problems in the Localmind platform itself: report them to Localmind at support@localmind.ai.
- Problems in n8n: report them to n8n, see [n8n's security policy](https://github.com/n8n-io/n8n/security/policy).

## Verifying a release

Every version is published from this repository by GitHub Actions, with npm provenance:

- `npm audit signatures` in a project that installed the package verifies its registry signature and provenance.
- The package file attached to each GitHub release can be verified with `gh attestation verify <file> --repo Localmind-GmbH/localmind-n8n-nodes --signer-workflow Localmind-GmbH/localmind-n8n-nodes/.github/workflows/publish.yml --source-ref refs/heads/main`, which confirms that this repository's release workflow built it from `main`, and its SHA-256 compared with the release's `SHA256SUMS`.
