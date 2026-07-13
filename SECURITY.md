# Security Policy

`zapo-rest` is a multi-session WhatsApp REST gateway. It holds API keys,
session credentials (via zapo-js + Postgres), optional media in S3/local
storage, and webhook HMAC secrets. Treat security reports carefully.

## Supported Versions

This project follows [Semantic Versioning](https://semver.org/). While the
public API is still `0.x`, security patches target the latest published
release on the default branch.

| Version            | Supported                          |
| ------------------ | ---------------------------------- |
| `0.x` latest       | ✅                                 |
| Older `0.x` tags   | ❌ – upgrade to the latest release |
| Unreleased `main`  | ✅ for reported issues             |

From `1.0.0` onward, security patches target the latest minor of the
current major (same policy as [zapo-js](https://github.com/vinikjkkj/zapo)).

## Reporting a Vulnerability

**Please do not open a public GitHub issue** for security problems.

- **Preferred:** GitHub Security Advisories on this repository
  (_Security → Report a vulnerability_).
- **Email:** `rafael_santana10@hotmail.com`

Expected response window: **48 to 72 hours** for an initial acknowledgement.

Include in your report:

- Affected version / commit
- A minimal reproducer
- Impact assessment (what an attacker can do, against whom)
- Whether you intend to publish independently and on what timeline

## Scope

### In scope

- Authentication bypass (`ADMIN_API_KEY`, instance API keys, SSE/WebSocket
  query fallbacks)
- Cross-instance data leakage (instance key accessing another instance)
- Secret leakage in logs, error responses, OpenAPI examples, or webhooks
  (API keys, HMAC secrets, Noise/Signal material from zapo store)
- Webhook HMAC forgery or signature verification bugs
- Path traversal / SSRF in media download or S3 public URL handling
- Privilege escalation from dashboard or docs static hosting
- Prompt-injection payloads aimed at downstream AI agents consuming
  message content (see [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) §2.6)

### Out of scope (regular bugs / upstream)

- Crashes or memory growth without data exfil or auth bypass
- WhatsApp ToS enforcement / ban risk (operational, not a CVE class)
- Vulnerabilities in `zapo-js` crypto/protocol – report those upstream:
  <https://github.com/vinikjkkj/zapo/security>
- Scanner noise without a concrete PoC against this codebase

## Disclosure Policy

We follow **coordinated disclosure** with a default 90-day window:

1. You report privately.
2. We acknowledge within 48–72h and start triage.
3. We ship a patched release when possible.
4. Advisory becomes public after the patch (or after 90 days, coordinated).

## What We Will Not Do

- We will not pay a bug bounty at this stage.
- We will not act on raw scanner dumps without a PoC.
- We will not respond to extortion attempts.
