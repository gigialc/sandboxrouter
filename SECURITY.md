# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub: **Security → Report a vulnerability** on this repository (a private advisory only the maintainers can see). Include what you found, how to reproduce it, and what it affects.

You'll get an answer within 3 working days. Fixes ship as a patch release, with credit to you in the advisory unless you'd rather stay anonymous.

## Supported versions

Only the latest published version of `@sandboxrouter/sdk` (and the Python client) gets security fixes.

## What's in scope

sandboxrouter runs on your machine and holds your provider API keys. In scope:

- A provider's key being sent to any host other than that provider's documented API (for example, an E2B-compatible adapter sending your E2B key to another cloud).
- Keys, tokens or file contents ending up in logs, errors, `check`/`bench` output, or `results/` reports.
- The HTTP server (`sandboxrouter serve`): bypassing its token, CORS that lets an untrusted website drive it, or reaching it from the network when it was meant to be local.
- Command or path injection in the adapters (for example, a file path that runs a shell command).
- The website or Playground leaking a key or token.

Out of scope: the isolation of the sandboxes themselves (report that to the provider), and sandboxes you started being billed by a provider.
