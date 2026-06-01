# Security Policy

PackPrice is an **internal desktop tool** for one workshop on a trusted LAN
(2–3 users, no public internet, no telemetry, no backend). This policy is sized to
that reality, not to a public SaaS.

## Reporting a vulnerability

Do **not** open a public GitHub issue for a security problem.

Report it privately to the project owner (the workshop owner / maintainer). If you
have a maintainer contact, use it directly. Include:

- what the issue is and where (file / IPC channel / config path),
- how to reproduce it,
- the impact you think it has (e.g. could a hostile `config.js` run code?).

Expect an informal acknowledgement; there is no SLA — this is an internal tool.

## Supported versions

Only the **latest beta build** distributed to the workshop PCs is supported. There
is no back-porting; fixes ship in the next `.exe`.

## Threat model (what we actually defend against)

The app runs on a trusted network with trusted users. The real risks are:

1. **Code execution via a malformed or hostile `config.js`.**
2. **Data loss** — clobbering the shared NAS config or a quote history.

Everything in the security model exists to mitigate those two. See
[`ARCHITECTURE.md`](ARCHITECTURE.md) §7 for the full table.

## Security invariants (must never regress)

These are enforced rules, not aspirations. A change that weakens one is a
vulnerability:

- `contextIsolation: true`, `nodeIntegration: false`.
- CSP `default-src 'self'` — no inline or external scripts/resources.
- `preload.js` exposes a **narrow, named** API only — never `ipcRenderer`, `fs`,
  or a generic channel passthrough.
- The renderer never touches `fs`, `path`, `crypto`, `vm`, or `ipcRenderer`.
- **No `eval`, `new Function`, `vm`, or dynamic `require`** on the external
  `config.js` (or any user-supplied path). It is parsed by scanning the JSON block
  and `JSON.parse`. `vm` is **not** a security boundary.
- Every config read is validated by `validateConfigSchema` before reaching the
  renderer; bad data fails fast with a readable message, never a silent `NaN`.
- A timestamped backup is written before every admin config write.
- The admin conflict check (mtime + sha256) prevents silent overwrite of another
  user's edit.

## What is **not** a security control

- `admin.clave` is stored in plaintext **on purpose** — it is an
  anti-accidental-click guard, not authentication (documented in
  `PLAN_Calculadora.md` §7.1). It is stripped before the config reaches the
  renderer. Do not treat it as a secret.

## Distribution

- Never sign the `.exe` with a borrowed or expired certificate.
- Never publish the code or `.exe` outside the workshop without the owner's
  explicit consent.
- `config.js` (real business data + admin password) is git-ignored and must never
  be committed.

## Dependencies

Runtime dependencies are kept near zero. `pnpm audit` is run before each release;
build-time transitive vulnerabilities on an offline internal app are tolerable but
are documented when ignored (`CLAUDE.md` §8.3). `electron` and `electron-builder`
are bumped deliberately, with a packaging test after each bump.
