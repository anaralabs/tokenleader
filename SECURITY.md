# Security Policy

tokenleader is a self-hosted tool: each team runs its own server and its own
fleet of daemons. There is no central service operated by this repo.

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/anaralabs/tokenleader/security/advisories/new)
— do not open a public issue. We're a small team; expect an acknowledgment
within a few days and a fix on a best-effort timeline, prioritized by impact.

## Scope — what we consider a vulnerability

- **Auth bypass** on the TOFU device model: posting as a handle you don't
  hold a device secret for, resurrecting a revoked device, redeeming a link
  code you shouldn't have, or bypassing the join gate.
- **The update chain**: getting a daemon to download or execute a binary the
  operator's server didn't publish (the daemon sha-verifies against the
  manifest and smoke-runs before swapping — breaking either check matters).
- **The directive channel**: making a daemon execute anything outside its
  allowlist (`restart`, `upload_logs`), or delivering directives without the
  admin bearer.
- **Server injection**: anything that turns handle/header/event data into
  code, shell, or SQL execution (handles are charset-validated specifically
  because they're interpolated into the rendered install command).
- **Cross-user data access** beyond what the dashboard intentionally shows.

## Out of scope

- The dashboard being public — that's an operator choice (the dashboard
  token is optional by design).
- Authenticated devices self-reporting inflated usage. Token counts are
  client-reported by trusted machines; the server clamps absurd values but
  the trust model is "your own team's laptops".
- Denial of service from unauthenticated traffic — put the server behind
  your platform's usual protections.

## Design notes for reviewers

Device secrets are random per machine, stored server-side only as SHA-256
hashes, and compared timing-safely. The daemon sends token *counts*, model
names, and timestamps — never message content. Binary updates flow only from
the operator's own server (`TOKENLEADER_ENDPOINT`), never from a third party
at runtime.
