# #1620-P1: plan token store and lock (local integrated candidate)

P1 is built and tested locally. The completed review partitions are recorded
in `handbacks/OA-P1SolA63.md` and `handbacks/OA-P1SolB64.md`;
DIRECTOR-P1B-0620 records their completion. The integrated assembly is bound
to base `5aef51644bf6cc69d24654ee3d20320ef2c4d71c` in
`handbacks/OA-P1Assemble64.md`. It includes the N1 deadline guard, the
Director's A10 wording and the reviewed lock-step documentation.

DIRECTOR-P1FINAL-0540 requests the mechanical comments, documentation and
proof-lint corrections in this candidate. The Director's read of that change
is next. The second different sign-in custody check is done (see the last
section). Security review, custody conformance, required CI, hosted Copilot,
records, publication and Nathan's acceptance remain owed. This is a local candidate, with no merge,
activation or production acceptance recorded.

This design retains revision 59's digest commit protocol and reader judgement,
with the later local corrections and stated limits. P2 to P5 stay PARKED and
get their own packages later. PR #1634
(`225ffc45525eb8d8dff6cc9fa70754a277396cb9`) stays FINAL RED and PARKED;
its bytes are reference only. The historical synthetic design probes remain
primitive evidence. Local implementation and review evidence is in the
handbacks above. Tag: OPUS (locks, retries, secrets, sign-in custody).

## What P1 is

P1 is the M5 custody's store for the owner's ChatGPT plan token: one owner-only
file, one kernel lock, one refresh state machine, and a `prepare`/`present`
pair. It is inert. No route, credential entry, `custody-main` request,
connector or hosted code imports it. P4 wires it later.

## F1 to F5 as they bear on P1

| Finding                                                                                              | P1's answer                                                                                                                                                                                                                                                                                                                                                                                          | Section                                   | Remaining owner of the rest |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------- |
| F1 durable pending before refresh                                                                    | Kept: a durable `pending` precedes every refresh request; nothing is sent unless that write is confirmed durable.                                                                                                                                                                                                                                                                                    | Lifecycle                                 | none                        |
| F1 post-rename directory fsync failure exposed `ready` (R2), and its double-failure residual (P1 R1) | The commit's last step is a SQLite commit of the record's digest in `<path>.state`, made only after the file is durable. A reader acts on the visible file only when its bytes match the committed digest, so a write the writer did not finish is never acted on, whatever the file shows. The hard-link undo still restores the exact `pending` after a single failure. `present()` reads no file. | Commit protocol, Locked reader, Lifecycle | none                        |
| F2 short permuted fragments                                                                          | Not fixed here. P1 guarantees no token text in its own outputs and hands P3 the held secrets.                                                                                                                                                                                                                                                                                                        | Secrets boundary                          | P3                          |
| F3 sign-in race, account and registration rejudged under the final write lock                        | P1 supplies the shared lock, a held-lock brand, the under-lock reader, the account verdict and the commit writer P2 must use. Host-only registration context is P2's to judge.                                                                                                                                                                                                                       | Sign-in seam                              | P2                          |
| F4 task bearer through the command boundary                                                          | Not P1. P1 holds no hosted bearer, subject or service token, and imports nothing hosted.                                                                                                                                                                                                                                                                                                             | Boundaries                                | P5                          |
| F5 authority after the last wait                                                                     | Every P1 judgement reads time and file state after its last wait. The P1 lock is a leaf lock held across no database wait. Delegation expiry and session endings are P5's.                                                                                                                                                                                                                           | Time after the last wait                  | P5                          |
| F6 prepare before accept (accepted)                                                                  | Kept: `PREPARE_BOUND_MS` 30 s, one deadline for lock wait and request, `present()` synchronous so W stays 3 s. A prepared pair is held in memory, so nothing is dropped between prepare and present.                                                                                                                                                                                                 | Prepare and present                       | P4, P5 wire it              |
| F9 one encoded file bound (accepted)                                                                 | Kept byte for byte: 51,346 below 65,536, one encoder for every writer.                                                                                                                                                                                                                                                                                                                               | File format                               | none                        |

## Accepted R2 contracts preserved

| Contract                                                                                                                                                                                                                                                                       | Where kept                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| One encoder; `TOKEN_FILE_BYTES` 65,536; `FIELD_MAX` 1,024 / 32,768 / 16,384 / 1,024; `tokenText` visible ASCII without `"` or `\`; largest pending file exactly 51,346 bytes                                                                                                   | File format                |
| Every writer (sign-in, rotation, pending, spent) goes through the one encoder; the reader re-validates with the same rules and reads at most 65,537 bytes                                                                                                                      | File format, Locked reader |
| Node 24 `node:sqlite` lock: `busy_timeout = 0`, `BEGIN EXCLUSIVE`, asynchronous 50 ms retry to an absolute deadline, `ROLLBACK` and `close()` in `finally`, no stale judgement                                                                                                 | Lock                       |
| Node 24 primitive evidence (`lane-scratch/OA-Design1620-R2-57/sqlite-primitive.mjs`, v24.21.0, exit 0, stderr empty) counts as primitive evidence only; the local wrapper and candidate executions are recorded in the completed review handbacks                              | Lock, Proofs               |
| Director ASK-2 fallback: loopback bind inside P1 if Node 24 refuses or misbehaves, with no new ask                                                                                                                                                                             | Lock                       |
| Prepare before accept: plan accept 35 s = `PREPARE_BOUND_MS` 30 s + `ACCEPT_WINDOW_MS` 5 s; `SEND_WINDOW_MS` 3 s and non-plan 5 s unchanged                                                                                                                                    | Prepare and present        |
| Refresh outcomes: 400 or 401 spent; proven pre-send failure restores `ready`; post-connect ambiguity, 5xx, 429, oversized or unparseable 200 stay `pending`; oversized rotated refresh stays `pending`; unusable access with a valid rotated refresh keeps it (`rotated_only`) | Lifecycle                  |
| Closed typed refusals, kinds-only logs, exactly one request per pending record, no retry                                                                                                                                                                                       | Types, Lifecycle           |
| Old takeover proofs kept byte for byte until replacements pass on the real P1 head                                                                                                                                                                                             | Old proofs                 |

The namespaced request shape (F7) and the terminal mapping (F8) are P4 and P3
contracts. P1 neither changes nor relies on them.

## Files and size

| File                                         | Content                                                                               | Estimate |
| -------------------------------------------- | ------------------------------------------------------------------------------------- | -------- |
| `packages/core-custody/src/token-file.ts`    | types, bound, encoder, decoder, locked reader, commit writer, committed digest, sweep | ~200     |
| `packages/core-custody/src/token-lock.ts`    | `withTokenLock`, `HeldLock` brand, directory and lock-file checks                     | ~80      |
| `packages/core-custody/src/token-refresh.ts` | one staged refresh request, bounded answer read, classification                       | ~110     |
| `packages/core-custody/src/plan-token.ts`    | `TokenHolder`: `prepare`, `present`, `secrets`; `signInVerdict`                       | ~150     |
| `tests/custody/fixtures/plan-token-child.ts` | child process: holds the lock, runs a holder, judges a sign-in, pauses on IPC         | test     |
| `tests/custody/fixtures/plan-issuer.ts`      | loopback fake issuer with request count and fault modes                               | test     |

About 540 product lines, under 800. If the builder's count passes 800, the
fixed split is P1a (`token-file.ts`, `token-lock.ts` and their tests) and P1b
(`token-refresh.ts`, `plan-token.ts`). No existing file changes; nothing is
added to `packages/core-custody/src/index.ts`. Tests import by path.

## Types and interfaces

```ts
// token-file.ts
export const TOKEN_FILE_BYTES = 65_536;
export const FIELD_MAX = {
  clientId: 1_024,
  accessToken: 32_768,
  refreshToken: 16_384,
  subject: 1_024,
} as const;
export const tokenText = (max: number): RegExp => new RegExp(`^[!#-\\[\\]-~]{8,${max}}$`, 'u');

export interface PlanTokens {
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly subject: string; // required in every state that holds tokens
  readonly expiresAt: number; // safe non-negative integer, ms since epoch
}
export type TokenFile =
  | { readonly state: 'ready'; readonly tokens: PlanTokens }
  | { readonly state: 'pending'; readonly tokens: PlanTokens; readonly since: number }
  | { readonly state: 'spent'; readonly subject: string };
export type TokenFileRefusal =
  'SUBSCRIPTION_TOKEN_FILE_OPEN' | 'SUBSCRIPTION_SIGN_IN_NEEDED' | 'SUBSCRIPTION_STORE_FAILED';
export type OnDisk =
  | TokenFile
  | { readonly state: 'absent' }
  | { readonly state: 'refused'; readonly code: TokenFileRefusal };
export type CommitOutcome =
  'durable' | 'unwritten' | 'reverted' | 'exposed' | 'unconfirmed' | 'TOO_LARGE' | 'NOT_TOKENS';

export function encodeTokenFile(file: TokenFile): Buffer | 'TOO_LARGE' | 'NOT_TOKENS';
export function readTokenFileLocked(held: HeldLock, path: string): OnDisk;
export function commitTokenFile(held: HeldLock, path: string, file: TokenFile): CommitOutcome;
/** The same protocol for P2's host registration file; bytes already bounded by the caller. */
export function commitBytes(
  held: HeldLock,
  path: string,
  bytes: Buffer,
): Exclude<CommitOutcome, 'unconfirmed' | 'TOO_LARGE' | 'NOT_TOKENS'>;

// token-lock.ts
declare const heldBrand: unique symbol;
export interface HeldLock {
  readonly [heldBrand]: true;
  readonly path: string;
}
export type LockRefusal = 'LOCK_WAIT_LAPSED' | 'LOCK_UNUSABLE';
export function withTokenLock<T>(
  path: string,
  options: { readonly deadlineAt: number; readonly now?: () => number },
  work: (held: HeldLock) => Promise<T>,
): Promise<
  { readonly held: true; readonly value: T } | { readonly held: false; readonly why: LockRefusal }
>;

// token-refresh.ts
export type RefreshStage = 'resolving' | 'connecting' | 'handshaking' | 'carrying' | 'answered';
export type RefreshResult =
  | { readonly kind: 'not_sent' } // failed or aborted before 'carrying'
  | { readonly kind: 'refused' } // HTTP 400 or 401
  | { readonly kind: 'answer'; readonly body: unknown } // HTTP 200, JSON, at most TOKEN_ANSWER_BYTES
  | { readonly kind: 'unknown' }; // everything else at or after 'carrying'
export const TOKEN_ANSWER_BYTES = 1_048_576;
export function refreshOnce(
  tokenUrl: URL,
  from: PlanTokens,
  deadline: () => AbortSignal, // rechecks the absolute deadline on each call
  now?: () => number,
): Promise<{ readonly result: RefreshResult; readonly sentAt: number | undefined }>;

// plan-token.ts
export const REFRESH_AHEAD_MS = 5 * 60_000;
export const PREPARE_HORIZON_MS = 60_000;
export const PREPARE_BOUND_MS = 30_000;
export type PlanRefusal =
  | 'SUBSCRIPTION_SIGN_IN_NEEDED'
  | 'SUBSCRIPTION_REFRESH_FAILED'
  | 'SUBSCRIPTION_STORE_FAILED'
  | 'SUBSCRIPTION_TOKEN_FILE_OPEN';
export type TokenAnswer =
  | { readonly ok: true; readonly accessToken: string }
  | { readonly ok: false; readonly code: 'SUBSCRIPTION_REFRESH_FAILED' };
export type PlanLogKind =
  | 'token refreshed'
  | 'token rotated only'
  | 'token refresh not sent'
  | 'token refresh refused: sign in again'
  | 'token refresh unresolved: sign in again'
  | 'token store failed'
  | 'token store exposed'
  | 'token store unconfirmed'
  | 'token store recovered';
export interface TokenHolderOptions {
  readonly file: string;
  readonly tokenUrl: URL; // https:, or http: on 127.0.0.1 for tests only
  readonly now?: () => number;
  readonly log?: (kind: PlanLogKind) => void;
  readonly fs?: Partial<TokenFs>; // fault injection for tests; production passes nothing
}
export interface TokenHolder {
  prepare(): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: PlanRefusal }>;
  present(): TokenAnswer; // synchronous: no file read, no lock, no refresh
  secrets(): readonly string[]; // every token value held in memory, for P3
}
export function tokenHolder(options: TokenHolderOptions): TokenHolder;
export function signInVerdict(
  onDisk: OnDisk,
  subject: string,
): 'write' | 'SIGN_IN_OTHER_ACCOUNT' | 'SIGN_IN_FILE_NEEDS_OWNER';
```

`TokenFs` is the narrow set of `node:fs` calls P1 makes (`lstatSync`,
`openSync`, `fstatSync`, `readSync`, `writeSync`, `fsyncSync`, `closeSync`,
`linkSync`, `renameSync`, `unlinkSync`, `rmSync`, `readdirSync`). Production
uses `node:fs` itself. Tests replace one call to inject a fault at a named
step in a real process; no proof replaces the whole module.

## File format (F9, kept)

- `encodeTokenFile` is the only encoder. It checks the exact key set of each
  state (no extra keys), every string against `tokenText(FIELD_MAX[key])`,
  and `expiresAt` and `since` as safe non-negative integers. It writes keys in
  one fixed order (`state`, `tokens` with `clientId`, `accessToken`,
  `refreshToken`, `subject`, `expiresAt`, then `since`) and refuses
  `TOO_LARGE` above `TOKEN_FILE_BYTES`. Because no permitted character needs
  escaping, the largest valid file is exactly 51,346 bytes; one more
  character in any field is refused by the encoder, never by the reader.
- The decoder applies the same rules. Anything else, including a parse
  failure, is `SUBSCRIPTION_SIGN_IN_NEEDED`. The parse error object is
  discarded, never logged or rethrown: V8's `JSON.parse` messages quote input
  text.

## Lock

`withTokenLock(path, { deadlineAt }, work)`:

1. The token directory must be owned by the process's user with
   `mode & 0o077 === 0` and no extended ACL; else `LOCK_UNUSABLE`.
   An ACL inspection failure also refuses. This closes symlink swaps by
   other users between the checks below and the open.
2. `<path>.lock`: if `lstat` says absent, create it with flag `wx`, mode
   0600, and close it. If present, it must be a regular file, not a symlink,
   owned by the user, `mode & 0o077 === 0` and no extended ACL; else
   `LOCK_UNUSABLE`. An ACL inspection failure also refuses. These checks
   use `lstat` only. No P1 code opens a file descriptor on an existing lock
   path outside SQLite, because closing any descriptor on that file in this
   process would drop SQLite's POSIX locks.
3. `new DatabaseSync(lock)`, `PRAGMA busy_timeout = 0`, then `BEGIN
EXCLUSIVE`. `SQLITE_BUSY` or "locked": wait 50 ms with `setTimeout`,
   retry, until `now() >= deadlineAt`, then `LOCK_WAIT_LAPSED`. Any other
   SQLite error: `LOCK_UNUSABLE`, lock-file bytes unchanged.
   After acquiring the transaction, read `now()` again. At or beyond
   `deadlineAt`, refuse `LOCK_WAIT_LAPSED` before the write probe. Prove the
   connection writable with a rolled-back `CREATE TABLE` in the main schema,
   then check that the lock path still names the inode opened. A failed probe
   or changed inode refuses `LOCK_UNUSABLE`. After a successful probe, read
   `now()` again and refuse `LOCK_WAIT_LAPSED` at or beyond `deadlineAt`,
   before creating the live brand or calling `work`. Closing the connection
   ends the transaction on each refusal.
4. Held: `work(held)` runs with a fresh `HeldLock`. In `finally`: mark the
   brand dead, `ROLLBACK`, `close()`. `readTokenFileLocked` and `commit*`
   refuse a dead brand (`SUBSCRIPTION_STORE_FAILED`, nothing read or
   written).
5. The lock is a leaf. Under it P1 awaits only its own file calls and the one
   refresh request. It is never taken inside a database transaction, and no
   database lock is awaited while it is held. Its kernel lock is released when
   the holder dies (primitive evidence: SIGKILL release and SIGSTOP exclusion
   on v24.21.0).

If a same-user process deletes or replaces the lock file, two holders can
overlap. The fences keep the refresh token sent once and nothing leaks, but
the displaced holder can overwrite an in-progress rotation; the next use then
asks for a fresh sign-in. Treat any SIGN_IN_NEEDED after such an event as
expected.

If `node:sqlite` fails to import under the locked Vitest on Node 24, warns
differently from the recorded empty stderr, or fails the cross-process suite,
the builder switches to the director's loopback-bind fallback inside P1,
keeping this interface, and records the failure. That switch needs a fresh Sol
check of the lock section only.

## Commit protocol (F1: no ready after a failed write)

`commitBytes(held, path, bytes)`, all synchronous under the held lock, with
`r` a fresh random suffix:

| Step | Action                                                                           | Failure here                                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | open `<path>.<r>.next` with `wx` and mode 0600; write every byte; `fsync`; close | remove `.next`; `unwritten`; the old file is untouched                                                                                                                    |
| 2    | if `path` exists: `link(path, <path>.<r>.undo)`                                  | remove `.next`; `unwritten`                                                                                                                                               |
| 3    | `rename(.next, path)`                                                            | remove `.next` and `.undo`; `unwritten`                                                                                                                                   |
| 4    | `fsync` of the directory                                                         | compensate: `rename(.undo, path)`, or `unlink(path)` when there was no prior file; best-effort directory `fsync`; `reverted`. If the compensating call throws: `exposed`. |
| 5    | remove `.undo`                                                                   | ignored; the next locked sweep removes it                                                                                                                                 |
|      |                                                                                  | `commitBytes` answers `durable`                                                                                                                                           |

`commitTokenFile(held, path, file)` is `commitBytes` and then one more step,
which is the commit point:

| Step | Action                                                                                                                                                                                                                                         | Failure here                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 6    | only after step 4 succeeded: on the committed-digest database `<path>.state` (SQLite, `journal_mode = delete`, `synchronous = full`), `begin immediate`, set the single row `committed(id = 1, digest)` to sha256 of the exact bytes, `commit` | `unconfirmed`; the committed digest stays the previous record's |
|      |                                                                                                                                                                                                                                                | `durable`                                                       |

- The token file keeps revision 58's format and bound. The digest lives in
  its own owner-only SQLite file, checked like the lock file (regular, not a
  symlink, the user's, `mode & 0o077 === 0`, opened by no non-SQLite code)
  and touched only under the held lock. It is not the lock database, so
  committing it never releases the lock.
- Why this closes the double failure: SQLite makes a commit visible only at
  its commit point and rolls back a failed or interrupted commit, including
  through a hot journal on the next open ([atomic commit](https://www.sqlite.org/atomiccommit.html)).
  So the digest a reader sees is always one whose commit succeeded, and that
  commit is only attempted after the file was durable. A file the writer
  judged `reverted`, `exposed` or `unconfirmed`, or a file left by a writer
  killed after step 3, never matches the committed digest. If power loss
  rolls back a digest commit, the reader sees an older digest and refuses,
  which is the safe direction.
- P2's host registration file uses `commitBytes` alone. It is not a token
  record and has no digest.

- `.undo` is a second name for the prior inode, which was itself made
  durable by its own commit. Step 2 copies no bytes and needs no data space,
  and compensation in step 4 is one rename of an existing inode. Neither
  needs to allocate data space.
- Only `durable` means written. Every caller treats `unwritten`, `reverted`,
  `exposed` and `unconfirmed` as "this write did not happen". `exposed` and
  `unconfirmed` are logged by kind.
- Sweep: every locked read (`readBytesLocked`, and so `readTokenFileLocked`)
  and every write (`commitBytes`, and so `commitTokenFile`) first removes every `<basename>.*.next` and
  `<basename>.*.undo` in the directory, so every hold that reads or writes the
  record sweeps before it does, the sign-in seam's included. No token copy
  survives beyond the next such hold. One gate, `enter()`, checks the hold and
  the path and then sweeps. (Second sign-in custody check, Q4: only `prepare`
  swept before 18 Oct; Sol's first review of P1a added the raw reader.)
- Revision 59 probe: `lane-scratch/OA-1620-P1Fix59/digest-arbiter-probe.mjs`
  (Node v24.21.0, `node --test`, exit 0, six passes, child stderr empty,
  synthetic text only). Sol's P1 R1 schedule (directory fsync and
  compensating rename both fail, writer `exposed`, rotated `ready`
  visible) makes a separate reader process refuse. A writer stopped after
  the rename and before the digest leads to a refusal, and so does a durable
  file whose digest commit fails. The original holder recommits its
  unwritten pair and a second process then presents it. A healthy rotation
  is presented. A single failure reverts to the exact `pending`, which is
  refused. The largest pending record is still 51,346 bytes. This is a
  schedule probe, not P1.
- Revision 58 probe `lane-scratch/OA-1620-P1Design58/commit-protocol-probe.mjs`
  (Node v24.21.0, exit 0, five passes) runs Sol's R2 schedule over real files
  with this protocol. A failed directory fsync on the `ready` write leaves the
  exact `pending` record visible, with no copy left. A second failure during
  compensation is reported `exposed`, never `durable`. A first write reverts
  to absent. The largest pending record is 51,346 bytes and reads back. This
  is a schedule probe of the protocol, not P1.

## Locked reader (F1: readiness and durability judgement)

`readTokenFileLocked(held, path)`:

1. `lstat`: absent gives `{ state: 'absent' }`. Not a regular file, a
   symlink, another owner, `mode & 0o077 !== 0`, an extended ACL, or an ACL
   inspection failure gives `SUBSCRIPTION_TOKEN_FILE_OPEN`.
2. `open` with `O_RDONLY | O_NOFOLLOW`; `fstat` must show the same device
   and inode as the `lstat`; read at most `TOKEN_FILE_BYTES + 1` bytes; more
   gives `SUBSCRIPTION_SIGN_IN_NEEDED`.
3. Read the committed digest from `<path>.state`. A missing database or
   row, or bytes whose sha256 differs from it, gives
   `{ state: 'refused', code: 'SUBSCRIPTION_SIGN_IN_NEEDED' }`: an
   unconfirmed record, whatever its `state` field says. A failure to read
   the digest gives `SUBSCRIPTION_STORE_FAILED`.
4. Decode with the encoder's rules.

The judgement every reader applies: **the visible file is acted on only when
its exact bytes are the committed record.** No P1 path reads the token file
without the lock. Revision 58's reader-side fsync is dropped: the committed
digest replaces it as the readiness judgement. The primitive probe
`lane-scratch/OA-1620-P1Design58/reader-fsync-probe.mjs` still records that
`O_NOFOLLOW` refuses a symlink (`ELOOP`) on v24.21.0.

Why no reader can act on a `ready` left by a failed write: a single failure
is reverted to the exact `pending` while the lock is held. Any further failure
(`exposed`, `unconfirmed`, or the writer killed before step 6) leaves the
committed digest on the prior `pending`, so the visible `ready` does not match
and every other holder and every restart refuses
`SUBSCRIPTION_SIGN_IN_NEEDED` and sends nothing. Revision 58's residual (a
second holder confirming and presenting an exposed `ready`) no longer exists.
The cost: a writer killed between rename and digest leaves a refusal until the
owner signs in, the same recovery cost R2 accepted for an ambiguous refresh.

A2 limit: restoring the token file and its matching `.state` database together
can bring back an old refresh token that passes the reader. After any restore
or copy of the token directory, sign in again. The digest detects a token file
restored on its own; it cannot detect a matching directory rollback.

## Lifecycle

`prepare()` is the only path that reads or writes the file. Calls in one
process share one `prepare` in flight. Every step below runs inside one
`withTokenLock(file, { deadlineAt: start + PREPARE_BOUND_MS })`, and `t` is
read after the lock is held.

1. Recover (its first locked read or write sweeps). If an `unwritten` record is held in memory and the committed
   digest is still the exact `pending` record it answers (same bytes this
   holder committed before its request), and the visible file is either that
   `pending` or this holder's own unwritten bytes, commit the unwritten
   record again (`commitTokenFile`). `durable`: log `token store recovered`
   and continue. Otherwise `SUBSCRIPTION_STORE_FAILED`, nothing sent. If the
   committed digest differs, drop `unwritten`.
   Every holder commit follows a locked fence read in the same hold: the
   hold's own reads go through `readTokenFileLocked`; recovery reads
   `committedDigest`, which sets the same generation fence, because
   `readTokenFileLocked` would refuse the holder's own unconfirmed bytes it
   must recommit. `every-holder-commit-follows-a-locked-read-in-its-hold.test.ts`
   pins the order.
2. Read with the locked reader and act:

| State read under the lock                                        | Action                                                                                                                                       | Answer                        |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| absent, `spent`, `pending`                                       | clear the held pair; nothing sent                                                                                                            | `SUBSCRIPTION_SIGN_IN_NEEDED` |
| refused                                                          | clear the held pair; nothing sent                                                                                                            | its code                      |
| `ready`, `t < expiresAt - REFRESH_AHEAD_MS - PREPARE_HORIZON_MS` | hold this pair                                                                                                                               | ok                            |
| `ready`, due                                                     | commit `pending` (same tokens, `since = t`). Not `durable`: nothing sent, `SUBSCRIPTION_STORE_FAILED`. `durable`: exactly one `refreshOnce`. | below                         |

3. After the one request, still under the lock:

| Result                                                                                   | Commit                                                                                                                          | Answer                                                                                               |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `answer` with a valid `access_token`, `expires_in` and a valid or absent `refresh_token` | `ready` with the new pair; `expiresAt = sentAt + expires_in * 1000`; an absent `refresh_token` keeps the held one (RFC 6749 s6) | ok if the new pair passes the horizon test, else `SUBSCRIPTION_REFRESH_FAILED` (kept, not presented) |
| `answer` with a valid rotated `refresh_token` and anything else unusable                 | `ready` with the rotated refresh token, the old access token, `expiresAt = t` (`rotated_only`)                                  | `SUBSCRIPTION_REFRESH_FAILED`; the next prepare refreshes with it                                    |
| `answer` with a `refresh_token` that fails `FIELD_MAX` or `tokenText`                    | none; `pending` stays                                                                                                           | `SUBSCRIPTION_SIGN_IN_NEEDED`                                                                        |
| `refused`                                                                                | `spent` with the subject                                                                                                        | `SUBSCRIPTION_SIGN_IN_NEEDED`                                                                        |
| `not_sent`                                                                               | `ready`, the old pair restored                                                                                                  | `SUBSCRIPTION_REFRESH_FAILED`; the next prepare may ask                                              |
| `unknown`, or `answer` with nothing usable                                               | none; `pending` stays                                                                                                           | `SUBSCRIPTION_SIGN_IN_NEEDED`                                                                        |

4. A post-answer commit that is not `durable` leaves the committed digest
   on the prior `pending` (by the commit protocol, whatever the visible file
   shows) and stores the intended record as `unwritten` in memory. Only this
   holder, only while that `pending` is still the committed record, writes
   it at its next prepare. It never resends.
   A restart, a second holder, or a holder that lost its memory reads
   `pending` and sends nothing until the owner signs in.

`sentAt` is read just before the request enters `carrying`, so `expiresAt`
never overstates the token's life. The held pair changes only to a newer
durable pair, and is cleared only when a locked read finds absent, `spent`,
`pending` or a refusal.

Accepted cost, as R2: an ambiguous outcome after the request was carried means
the owner signs in again. That is recovery, not resubmission, and is logged
`token refresh unresolved: sign in again`.

## Refresh request stages

`refreshOnce` uses `node:https` (or `node:http` for a `127.0.0.1` test issuer)
with `agent: false`, no redirect following, and the prepare's deadline,
checked again on each call. The stage moves `resolving` (lookup), `connecting`,
`handshaking`, `carrying` (on `secureConnect` for https, `connect` for the
loopback http issuer), `answered`. No request byte is handed to the socket
before `carrying`: the request is ended only at `carrying`, and only if the
absolute deadline, checked again at that instant, has not passed. A lapse
there is `not_sent`, so a slow connection setup can never carry the refresh
token past `PREPARE_BOUND_MS`.

- Any error or abort while the stage is before `carrying`: `not_sent`. This
  judgement comes from the recorded stage, never from an error code.
- Status 400 or 401: `refused`. Status 200: read the body up to
  `TOKEN_ANSWER_BYTES + 1`; more, a cut body or invalid JSON: `unknown`;
  else `answer`. Anything else (3xx, 429, 5xx, reset, timeout after
  `carrying`): `unknown`.
- Body: `grant_type=refresh_token`, `refresh_token`, `client_id`, and the
  `resource` of OpenAI's open-source flow as #1634 sent it. The builder
  re-reads the official sign-in page on the day, reading only.

## Prepare and present (F6, P1 half)

- `prepare()` ok means a pair is held in memory and presentable until at
  least `u + PREPARE_HORIZON_MS`, where `u` is the last time read under the
  lock (`t`, or the time read after the post-answer commit). `u` follows the
  offer, and a plan call presents at most 38 s after its offer (35 s accept
  plus 3 s W), so nothing prepared lapses before its present. The lock wait and the request share one absolute
  deadline, `start + PREPARE_BOUND_MS`. A post-answer commit is never aborted
  at that deadline, because aborting it would lose a rotated pair. If file
  calls stall past it, the caller's accept window lapses and nothing is sent.
- `present()` is synchronous. It reads `now()` at the call and answers the
  held access token when `now < expiresAt - REFRESH_AHEAD_MS`. Otherwise it
  refuses `SUBSCRIPTION_REFRESH_FAILED` and nothing is sent. It reads no
  file, takes no lock and never refreshes, so the 3 s W is spent only on the
  write. A refresh in flight in the same process does not clear the held
  pair, so a call prepared earlier is not dropped at handoff. A custody
  restart between prepare and present loses the held pair: present refuses
  and nothing is sent.

## Sign-in seam (F3, P1 half)

P1 supplies, and P2 must use, one shape for the final judgement:
`withTokenLock(file, { deadlineAt: now + 45_000 }, held => ...)`, then under
that hold `readTokenFileLocked`, then `signInVerdict(onDisk, grantSubject)`:

| On disk under the lock                                 | Verdict                                                   |
| ------------------------------------------------------ | --------------------------------------------------------- |
| absent                                                 | `write`                                                   |
| `ready`, `pending` or `spent` with the grant's subject | `write` (replacing `pending` or `spent` is F1's recovery) |
| `ready`, `pending` or `spent` with another subject     | `SIGN_IN_OTHER_ACCOUNT`                                   |
| refused                                                | `SIGN_IN_FILE_NEEDS_OWNER`                                |

Then `commitTokenFile(held, file, { state: 'ready', tokens })`, where only
`durable` counts as signed in. A refresh holds the lock at most
`PREPARE_BOUND_MS` plus its file calls, inside the 45 s sign-in wait.

P1 does not read or judge `chatgpt-host.json`. P2's package must judge
registration under the same hold: absent, host-only (`{ extAgentHostId }`,
which permits its own grant), or registered with a `clientId`. It must also
write both files with `commitBytes`/`commitTokenFile` in that hold. P1 does
not implement or assume that P2 work.

## Time after the last wait (F5, P1 half)

- Each `prepare` reads `t` after its lock wait and after the locked read.
  `sentAt` is read at `carrying`. `present` reads `now()` at its own call.
  No P1 judgement uses a time read before a wait.
- The file state used for every decision comes from the locked reader in the
  same hold (generation fence). No earlier read is reused.
- A `present()` ok is not authority. Delegation expiry, session endings,
  membership, lease and fence judgement after the last database wait are
  P5's, parked. P1 adds no edge to the database lock order.

## Secrets boundary (P3 stays open)

P3's fragment rule (F2) is unresolved and is not claimed here. P1 itself
guarantees:

- No token byte appears in any P1 log (`PlanLogKind` is closed), refusal
  code, thrown error, or file other than the token file and its transient
  `.next` and `.undo` names, all mode 0600 and swept by the next hold that reads or writes.
- Parse failures of the token file and of the issuer's answer discard the
  error object.
- `secrets()` returns every token value the holder holds (presented access
  token, held refresh token, `unwritten` pair). P3 needs these to judge
  answers.
- P1 opens no route, so no plan answer can leave custody until P4 merges, and
  P4 is blocked by P3's approval.

## Boundaries

- Depends on nothing in P2 to P5. Changes no existing file. Imports only
  `node:fs`, `node:path`, `node:crypto`, `node:sqlite`, `node:https`,
  `node:http`.
- Holds no hosted bearer, verified subject, service token or plan credential
  for any hosted code (F4 stays P5's).
- Two stacked pull requests, `Part of #1620`, OPUS, after the 18 Oct re-cut
  of #1661 (1,107 product lines, over the 1,000 ceiling): P1a, branch
  `feat/1620-p1a-token-lock-and-file` (`token-lock.ts`, `token-file.ts`), and
  P1b on it, branch `feat/1620-p1b-plan-token-holder` (`token-refresh.ts`,
  `plan-token.ts`, this file). Stack: Node 24 (`engines.node >=24`, `.nvmrc` 24), pnpm
  12.3.4, the locked Vitest 5.0.0. No dependency, install or image pull. The
  builder rebinds to the main head current at the cut, re-reads this file's
  hash, and records Node 24 evidence (`node:sqlite` stderr under Vitest and
  under `process.execPath`).
- Gates: Sol on the exact head; Opus FIX-DIFF-READ of each fix; the second,
  different check for sign-in custody; `/security-review` (custody, egress,
  secrets); Copilot on the hosted head; custody's green conformance proof and
  Nathan's acceptance (protected component); every required check green.
  The race-attack sub-agent runs before READY. No builder starts before a
  fresh Sol design check approves this file.

## Proofs and local evidence

The completed local review handbacks above record the executed candidate
suites, independent proofs and undo-fix results. The schedules below retain
the design's proof requirements; their description alone is not an execution
receipt. Later custody, conformance, CI and publication gates remain owed.

All under `tests/custody/`, Node 24, `mkdtemp` directories at mode 0700,
synthetic `synthetic-*` tokens, a faked clock, the loopback fake issuer with
a request counter, and real child processes via `process.execPath` with the
fixture for every "second holder" and "restart". A hostile case names the
expected refusal and request count. "Healthy" cases must pass in the same
file.

1. `the-plan-token-lock-admits-one-holder-across-processes.test.ts`. Kept
   from R2: A killed with SIGKILL while holding, then B and C race and a
   fourth starts while B holds; a SIGSTOP holder excludes everyone until
   SIGCONT and release; three same-process holders; a failed contender's
   `close()` keeps another connection's lock; the wait lapses at its
   deadline (`LOCK_WAIT_LAPSED`); a non-SQLite lock file gives
   `LOCK_UNUSABLE` with its bytes unchanged; lock mode 0644, lock symlink,
   and directory mode 0755 each give `LOCK_UNUSABLE`; a dead `HeldLock`
   reads and writes nothing. First case: `node:sqlite` imports under the
   locked Vitest and the child's stderr is recorded. Healthy: a waiter
   enters after release, and no two hold intervals in the shared log overlap.
2. `a-failed-token-write-never-exposes-ready.test.ts` (F1, new). With the
   fault injected in the writer's process: Sol's R2 schedule (the directory
   fsync fails on the `ready` write) leaves the exact `pending` record, and a
   second holder process then prepares to `SUBSCRIPTION_SIGN_IN_NEEDED` and
   presents nothing (1 request in total). The same holds with the fault at
   file fsync, link and rename. The directory fsync fails on the `pending`
   write: `ready` is restored, 0 requests, `SUBSCRIPTION_STORE_FAILED`.
   Sol's P1 R1 schedule (`commit-contract.test.mjs`, unchanged): the
   directory fsync and the compensating rename both fail (`exposed`), and a
   restarted holder and a second holder process each refuse
   `SUBSCRIPTION_SIGN_IN_NEEDED` and present nothing (1 request in total).
   The digest commit fails after a durable file (`unconfirmed`): the same.
   A writer killed after the rename and before the digest (the fixture
   pauses on IPC): the same. A hand-edited token file, or a token file restored
   on its own from an old copy, does not match and is refused. The spent token is never sent
   again in any case. Leftover
   `.next` and `.undo` files are gone after the next hold. Healthy: Sol's
   healthy control; the same holder's `unwritten` pair is recovered at its
   next prepare and presented (1 request in total).
3. `a-refresh-token-is-never-sent-twice.test.ts` (F1, kept and extended).
   The `pending` write fails, then a restart and a second live holder
   prepare (0 requests). Issuer 200 with the `ready` commit failing, then a
   restart and a second holder (1 in total, both refuse). Killed after
   `pending` (0 later). Stage classification: an issuer that resets after
   reading the request, a 30 s stall aborted at the deadline, 429, 503 and a
   302 all leave `pending` (1, then 0). Stage proof: an `https:` URL to a
   loopback TCP server that answers bytes that are not TLS fails in
   `handshaking` (`not_sent`, `ready` restored, the issuer counter
   unchanged); a closed loopback port fails in `connecting` (`not_sent`); a
   deadline that lapses during the lock wait sends nothing and leaves
   `ready`. Healthy: the next prepare after `not_sent` reaches the issuer; a
   second holder after a successful rotation presents the rotated token with
   no request of its own; a normal rotation across a faked expiry.
4. `the-token-file-holds-every-pair-it-allows.test.ts` (F9, kept). The
   largest valid file encodes to exactly 51,346 bytes and reads back; one
   character more in each field is refused by the encoder; `"`, `\` and an
   extra key are refused; Sol's 32,768 + 32,768 pair is refused before any
   write; a rotated refresh token over its maximum leaves `pending`
   (`SUBSCRIPTION_SIGN_IN_NEEDED`); an over-long rotated access token keeps
   the rotated refresh token (`rotated_only`). Hostile reader cases: a
   symlinked token file, mode 0644, 65,537 bytes, a swapped inode. Healthy:
   an ordinary pair.
5. `the-plan-token-is-presented-only-while-live.test.ts` (kept, extended).
   Sol's `sol-1634-expiry-during-store` and `sol-1634-expired-unwritten-token`
   ported; `present()` at exactly `expiresAt - REFRESH_AHEAD_MS` refuses; a
   `pending` file is never presented by a holder that prepares after it;
   after a locked read finds `spent`, an earlier held pair is refused.
   Behavioural proof that `present` reads nothing: after prepare, the token
   file is removed and another process holds the lock, and `present()` still
   answers at once. Healthy: a call prepared before a same-process refresh
   presents its token during that refresh (no drop at handoff).
6. `the-plan-token-keeps-a-rotation-whatever-the-answer-size.test.ts` (kept).
   Sol's `sol-1634-rotated-refresh-size` (96 KiB, 300 KiB) and
   `sol-1634-oversized-successful-rotation` against the 1 MiB read; a
   1.5 MiB 200 leaves `pending` and nothing more is sent. Healthy: a normal
   200; a 200 without `refresh_token`.
7. `the-plan-token-prepares-within-its-bound.test.ts` (F6, kept, extended).
   Healthy 4 s and 20 s refreshes complete within `PREPARE_BOUND_MS` and
   `present()` answers at +38 s; a lock held by a sign-in for 10 s, then a
   15 s refresh, completes; a 31 s refresh is aborted after `carrying`,
   leaving `pending`; a fresh pair with `expires_in` 300 is kept but refused.
8. `the-sign-in-seam-judges-under-the-held-lock.test.ts` (F3, P1 half).
   Every row of the verdict table. Two child processes with different
   subjects judging and committing under the lock against an absent file:
   exactly one writes, and the other gets `SIGN_IN_OTHER_ACCOUNT` with the
   file unchanged. A sign-in waits out a 20 s refresh and commits. Healthy:
   the same subject replaces `pending` and `spent`, and a holder then
   prepares and presents.
9. `no-plan-token-text-leaves-the-holder.test.ts` (P1's secret guarantee).
   Planted synthetic tokens. A malformed 200 that quotes the refresh token,
   a malformed token file, every injected file fault and a lock refusal:
   every log line is a `PlanLogKind`, every answer a closed code, and every
   thrown error, together with child stdout and stderr, contains no 4-character
   substring of any planted token. Healthy: `secrets()` lists exactly the
   held values.

The integrated final verifier after P5 adds the fsync, exposed and stage
schedules to its real custody process (as R2 required). That verifier is not
P1's.

## Old proofs and their retirement (kept)

Nothing is deleted until the replacements above pass on the actual P1 head.
`token-lock-keeps-its-successor.test.ts` (builder, sha256
`a16b865c8fcb86910470d0b8eeef19ff0407319f10b22b607c4178fb0a18cb20`) and
Sol's `sol-1634-stale-takeover-race.test.ts` (sha256
`af76593f9d4a4e6098d2d8f3948abb6dfda9bf3e783c2e1fc36a95aec7f92c77`) test
`takeOverIfStale`, `statSync` and `renameSync`, none of which exists in P1.
Their guarantee (no contender enters while a live holder holds the lock) is
restated by proof 1, including the suspended live holder. Both stay byte for
byte in the #1634 clone. P1's pull request body records both hashes and the
replacement names.

## Parked

P2 (sign-in, F3 registration), P3 (fold, terminals, F2 fragments), P4
(route, F7 shape, F8 mapping, agent prepare) and P5 (task carriage, F4
bearer, F5 final authority) are PARKED until P1 is approved, each as its own
later package. Their R2 estimates (440, 300, 620, 560) and split points are
unchanged and are not measurements. This file asks nothing of them beyond the
seams named above.

## Remaining gates and follow-ups

No owner question or engineering ASK is raised by this wording correction.
The commit point remains step 6, SQLite's atomic commit of the digest, and the
reader's readiness judgement remains the digest match.

Next is the Director's read of each part's diff, then required CI and
records once. Security review before a
sensitive PR, custody conformance, Nathan's acceptance, hosted Copilot,
publication and exact-head required checks remain applicable. No merge,
activation or production acceptance follows from local build or review.

DIRECTOR-P1FINAL-0540 records a separate Opus follow-up before M5 sign-in for
production acceptance of `http://127.0.0.1`, which this design permits only
for tests. P2 to P5 remain PARKED.

### Sign-in step items closed in P1 (18 Oct)

- Second, different sign-in custody check: run on #1661 head `35908c26`,
  fresh Opus context, report
  `lane-scratch/OA-Custody-P1/signin-custody-check.md`. Four questions hold
  (the verdict table, one hold with a fresh read after the wait, no token
  text out, inputs and redirects); one failed (Q4, copies swept only in
  `prepare`), fixed in P1a with
  `every-token-hold-sweeps-the-copies-an-earlier-hold-left.test.ts`.
- Different UID: `the-token-file-is-unreadable-to-another-user.test.ts`
  (P1a). A process as `nobody` is refused the token file, `.lock`, `.state`
  and the directory listing, and still refused each file with the directory
  opened to search. It runs where the test can reach another user (root, or
  passwordless `sudo`, as on GitHub-hosted runners) and is skipped with its
  reason elsewhere. Root-to-65534 crossing on `node:24-alpine`:
  `lane-scratch/OA-Custody-P1/uid-crossing.log`, with the undo (token file
  at 0644) readable as expected.
- Linux ACL branch: not applicable on the M5. Custody there runs under
  launchd on macOS, as the model agent's child
  (`deploy/m5/ops-astro-model-agent.plist`, `docs/local/model-agent.md`
  install step 5), so `aclFree` takes the `ls -lde` branch, which the darwin
  ACL cases test. The GNU `ls -ld` `+` branch runs only on Linux (CI).
- Time Machine: at the M5 sign-in step the owner excludes the token
  directory before the first sign-in, with `tmutil addexclusion <dir>`
  (a sticky exclusion that stays with the folder), and checks it with
  `tmutil isexcluded <dir>`, which must answer `[Excluded]`. No agent runs
  `tmutil`. Why: a backup copy is a refresh token outside the owner-only
  directory. The committed digest refuses a restored file, but the copy
  itself can still be live at the issuer. P2's owner checklist
  (`docs/local/chatgpt-plan.md`, not yet written) must carry this step
  and the check.

### Left for later parts

- The token directory's ancestors are not judged. On the M5 the directory
  sits under the owner's home; P2's checklist must confirm no ancestor
  is writable by another user.
- Settled by #1704: `tokenHolder` throws at build for a `tokenUrl` that is
  neither on `https://auth.openai.com` nor a 127.0.0.1 test issuer, so no
  `pending` is committed for a request it may not send, and `refreshOnce`
  holds the same rule. The production composition builds its holder with
  `productionTokenHolder` (`plan-token-production.ts`), which accepts only
  `https://auth.openai.com`, with no credentials in the URL, and answers
  anything else, loopback included, `SUBSCRIPTION_ISSUER_REFUSED` at start.
  P4 wires it.
