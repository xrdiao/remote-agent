# Connection and security

[README](../README.en.md) · [中文](security.md)

## Connection

The relay uses CDP to connect to desktop applications on the same computer. The phone connects through an HTTPS tunnel or over the LAN. A fixed web entry discovers changed relay addresses and reauthenticates with saved credentials. The Pages frontend and the local relay are separate components. Keep `~/.agent-remote/` and start the relay as the same OS user.

## Pairing and device entries

- Authorize through a time-limited one-time link, QR code or manual pairing code. Authenticator codes are still required when two-step verification is enabled.
- Refreshes and other pages in the same browser can reuse stored credentials. A different browser is not automatically authorized just because it is on the same phone.
- **Paired devices → Add entry** invites another browser. An existing trusted entry checks the verification code and approves it; the new entry receives independent credentials.
- The list groups devices and entries using explicit ownership information, not matching iPhone names, IP addresses or browser fingerprints. Grouping does not share authorization; entries can be revoked separately.
- Removing an entry invalidates its authorization and disconnects associated long-lived connections. It does not kill Agent tasks or terminal processes already running on the computer.

## Protecting access

Pair only trusted devices. Keep pairing links, token-bearing URLs, QR codes, configuration and logs private. CDP debug ports should be accessible only locally, not exposed to the internet. Use the authenticated relay entry over HTTPS and optionally enable `npm run 2fa`. Revoke access if a phone is lost:

```bash
npm run devices
npm run devices -- remove <id>
```

`npm run reset` clears all pairings, two-step verification and related configuration; it is not a normal reconnect step. It does not terminate running desktop tasks or tunnel processes.

The tool can operate real terminals, projects and files accessible to the current OS user. It does not create an OS sandbox. Tunnel HTTPS is not a claim of end-to-end encryption; self-hosting still involves trust in the computer, tunnel service and frontend entry. Agent accounts, subscriptions and permissions remain managed by their own applications.

## Public screenshots

README uses only redacted images under `docs/screenshots/redacted/`. Originals and test backups remain in the Git-ignored `_shots/readme-20261022/`; do not commit them or publish that directory.
