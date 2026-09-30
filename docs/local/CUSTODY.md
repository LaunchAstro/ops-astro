# Custody: the business's secrets

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

What C31 built, what it proves, and what to do when a credential leaks.

## What is here

`custody_secrets` (migration 0048) holds one row per named secret at one
scope: the whole business, or one client (a party id, the scope a
party-scoped grant names). A row says whether a value is set, who set or
cleared it, and when the broker last used it.

A value is sealed before any statement is built
(`packages/core-records/src/custody/sealing.ts`): X25519 against a fresh
ephemeral key, HKDF-SHA256, then AES-256-GCM. The application holds only the
broker's public key, `CUSTODY_KEY_ID` and `CUSTODY_PUBLIC_KEY`, from the
environment or the ignored `.local/custody.env`. It can seal and cannot open.
The private half is the broker's (ADR 0028), which AW-01 builds. With no public
key configured, `secret.set` refuses `DEPENDENCY_NOT_LANDED` and stores
nothing.

The application role is refused the three sealed columns by column grants, so
a read that names them fails in the server, whatever the code asks.

## The commands

| Command        | Permission key   | Agent | What it does                                              |
| -------------- | ---------------- | ----- | --------------------------------------------------------- |
| `secret.list`  | `custody:manage` | never | rows at the scopes the caller holds the key at            |
| `secret.set`   | `custody:manage` | never | seals and stores a value, business-wide or for one client |
| `secret.clear` | `custody:manage` | never | removes the value, keeps the row and who cleared it       |

A client-scoped holder of `custody:manage` lists that client's rows only;
setting and clearing need the key business-wide. The body of a set reaches no
log, error, audit payload or repeat-request row: the envelope stores its digest
only. The tests are `tests/custody/c31-credentials.test.ts` and
`tests/surfaces/c31-keys-panel.test.tsx`.

`markSecretUsed` moves a row's last-used time. The broker calls it when it
injects the secret into a dispatch; setting a value again leaves it alone.

## When a credential leaks

Run these in order, and record each step with its time in the incident's task.

1. **Disable it.** Clear the secret (`secret.clear`), so nothing new can use
   it. Revoke it at the provider too if the provider allows that.
2. **Rotate it.** Issue a new credential at the provider and set it
   (`secret.set`). Never reuse the leaked value.
3. **Invalidate what depended on it.** Revoke the delegations and cancel the
   runs that were using the connection (`delegation.revoke`, `task.cancel`),
   and end the sessions of any person whose login was involved.
4. **Tell the provider** through its security contact, with the time window.
5. **Review its use.** Read the audit chain for the secret's `secret.set`,
   `secret.clear` and the broker's calls in the window, and the row's last-used
   time.
6. **Assess the clients affected**: every client whose connection used the
   credential in the window.
7. **Notify the named recipients**: the owner, then the second operator. Client
   notification follows the privacy decision for a notifiable breach.

The drill runs this list on staging against a planted test credential and
leaves a receipt: each step's time, who did it, and the audit rows it produced.
It has not run: nothing is deployed from this build (TR-SEC-5).
