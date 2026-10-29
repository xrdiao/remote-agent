# Connection and security

[README](../README.en.md) · [中文](security.md)

## Connection

The relay uses CDP to connect to desktop applications on the same computer. The phone connects through an HTTPS tunnel or over the LAN. A fixed web entry discovers changed relay addresses and reauthenticates with saved credentials. The Pages frontend and the local relay are separate components. Keep `~/.agent-remote/` and start the relay as the same OS user.

## Pairing and device entries

- Run `npm run pair` to open a dedicated pairing window with a QR code, manual code and 3-minute countdown. The same code accepts multiple requests until expiry. Compare each origin and six-digit code, then click Allow connection; no checkbox or device name is required. Entries for the current device are grouped automatically. Pair another device starts a new group without extending the deadline; this is user-directed grouping, not physical-device detection. Closing the window, expiry or Ctrl+C in the pairing terminal invalidates pending requests while approved entries remain authorized. TOTP is still required when enabled.
- Each entry owns a P-256 signing key. Browsers store a non-exportable private key in origin-local IndexedDB; the updated Android shell uses an origin-specific Android Keystore key. The relay stores only public keys. Tokens require a valid signature to authenticate.
- Proofs bind the computer, token and request method/path, with a one-minute validity window and a single-use random identifier. Main and voice sockets, HTTP APIs, uploads and Android background requests use this rule. Keep device clocks synchronized. Legacy bearer-only pairings must be approved again. Android requires shell version 1.4.0. Clearing site data and losing the private key also requires pairing again.
- Web keys require HTTPS (a fixed entry or HTTPS tunnel); ordinary LAN HTTP pages no longer support web pairing. The computer's localhost approval page remains available.
- Refreshes and same-origin pages in the same browser can reuse stored credentials. A different site entry or browser is not automatically authorized just because it is on the same phone.
- Cross-site navigation carries only computer names, public IDs and entry addresses, without existing computers' long-lived tokens or address decryption keys. The destination uses its own pairing; a new entry needs pairing or approval from a trusted entry. The original entry retains its pairings and remains accessible from the computer list.
- **Paired devices → Add entry** invites another browser. An existing trusted entry checks the verification code and approves it; the new entry receives independent credentials.
- The list groups devices and entries using explicit ownership information, not matching iPhone names, IP addresses or browser fingerprints. Grouping does not share authorization; entries can be revoked separately.
- Removing an entry invalidates its authorization and disconnects associated long-lived connections. It does not kill Agent tasks or terminal processes already running on the computer.

Key possession prevents impersonation using a copied token alone. It is not end-to-end encryption or application-body integrity: TLS still protects request and response content. Compromised page scripts may invoke the entry's signer, so the frontend must remain trusted. See the scope described in [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html#section-11.7) and the browser requirements in [Web Crypto](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/generateKey). This project uses its own proof format, not the OAuth DPoP protocol.

## Protecting access

Pair only trusted devices. Keep pairing links, token-bearing URLs, QR codes, configuration and logs private. CDP debug ports should be accessible only locally, not exposed to the internet. Use the authenticated relay entry over HTTPS and optionally enable `npm run 2fa`. Revoke access if a phone is lost:

```bash
npm run devices
npm run devices -- remove <id>
```

`npm run reset` clears all pairings, two-step verification and related configuration; it is not a normal reconnect step. It does not terminate running desktop tasks or tunnel processes.

The tool can operate real terminals, projects and files accessible to the current OS user. It does not create an OS sandbox. Tunnel HTTPS is not a claim of end-to-end encryption; self-hosting still involves trust in the computer, tunnel service and frontend entry. Agent accounts, subscriptions and permissions remain managed by their own applications.

## Public screenshots

README uses only redacted images under `docs/screenshots/redacted/`. Originals and test backups remain in the Git-ignored `_shots/` directory; do not commit them or publish that directory.
