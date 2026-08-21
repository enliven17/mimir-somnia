# OWASP web/API security review

Date: 2026-08-12. Scope: Next.js web/API, agent signed API, copy permissions, research gateway and production dependencies.

## Result

No open critical web finding was identified in the reviewed paths. Financial writes use parameterized SQL and signed wallet requests with nonce/idempotency/audit controls. Agent capability and owner/operator authorization is deny-by-default. EOA/ERC-1271 verification fails closed. Research performs URL, port, credentials, DNS/IP and every-redirect validation, bounds MIME/bytes/time, and has global/per-agent kill switches. React output is escaped and the repository has no dynamic code execution, shell execution from request data, credentialed wildcard CORS, or unsafe HTML rendering.

The review added CSP, HSTS, frame denial, MIME-sniffing protection, referrer and permissions policy headers. CSP retains `unsafe-inline` for Next.js hydration/styles compatibility; removing it requires a nonce-based rendering migration and is tracked as hardening, not represented as an audit pass.

Production `npm audit --omit=dev` is clean after updating the lockfile and overriding the vulnerable transitive Axios line to 1.18.0. The local shell runs Node 20 while the application and XMTP require Node 22; CI/hosting must use Node 22 or newer as declared in `package.json`.

## Remaining launch boundary

This source review is not an independent smart-contract audit, penetration test, legal/custody/sanctions review, or Somnia Shannon testnet deployment attestation. Funded basket deposits and unaudited contracts remain disabled until those external reviews are recorded. Production must configure a provider `SOMNIA_RPC_URL`; the public fallback is development/testnet-only.
