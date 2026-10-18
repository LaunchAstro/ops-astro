// SPDX-License-Identifier: AGPL-3.0-only
//
// The plan token file (#1620 P1): one owner-only record, one encoder that
// bounds every writer, a reader and a writer that work only under the held
// plan token lock, and the committed digest that says which bytes are the
// record.
//
// The commit point is the SQLite commit of the record's sha256 in
// `<path>.state`, made only after the file itself is durable. A reader acts on
// the visible file only when its exact bytes match that digest, so a write
// the writer did not finish (reverted, exposed, unconfirmed, or killed between
// rename and digest) is never acted on, whatever the file shows.
//
// The design (#1620 P1) keeps the format, the locked reader, the commit
// protocol and the committed digest in this one file, so it runs past the
// pedantic length limit.
/* oxlint-disable max-lines */
//
// No token text reaches a log, a refusal or a thrown error: parse errors are
// discarded, since V8's `JSON.parse` messages quote their input.
//
// Each digest commit is fenced to its hold's generation: it commits only while
// the committed digest is still the one this hold last read or wrote, so two
// holds that read the same record cannot both commit it.
//
// If a same-user process deletes or replaces the lock file, two holders can
// overlap. The fences keep the refresh token sent once and nothing leaks, but
// the displaced holder can overwrite an in-progress rotation; the next use then
// asks for a fresh sign-in. Treat any SIGN_IN_NEEDED after such an event as
// expected.
//
// Stated limit: the digest binds bytes, not a generation outside the
// directory. Restoring or copying the token file together with its `.state`
// (one directory restore) brings back an old refresh token that passes the
// reader. After any restore or copy of this directory, sign in again. The
// issuer's refusal of a reused refresh token then stores `spent` and answers
// SUBSCRIPTION_SIGN_IN_NEEDED.

import { createHash, randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { basename, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { aclFree, holds, ownerOnly, privateFile, type HeldLock } from './token-lock.ts';

export const TOKEN_FILE_BYTES = 65_536;
export const FIELD_MAX = {
  clientId: 1_024,
  accessToken: 32_768,
  refreshToken: 16_384,
  subject: 1_024,
} as const;
/** Visible ASCII without `"` or `\`, so no permitted character needs escaping. */
export const tokenText = (max: number): RegExp => new RegExp(`^[!#-\\[\\]-~]{8,${max}}$`, 'u');
/** P2's host registration file: the one sibling `commitBytes` may also write under the token lock. */
export const HOST_REGISTRATION_FILE = 'chatgpt-host.json';

export interface PlanTokens {
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly subject: string;
  readonly expiresAt: number;
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

/** The `node:fs` calls P1 makes. Tests replace one to fault a named step. */
export type TokenFs = Pick<
  typeof nodeFs,
  | 'lstatSync'
  | 'openSync'
  | 'fstatSync'
  | 'readSync'
  | 'writeSync'
  | 'fsyncSync'
  | 'closeSync'
  | 'linkSync'
  | 'renameSync'
  | 'unlinkSync'
  | 'rmSync'
  | 'readdirSync'
>;
const files = (fs: Partial<TokenFs>): TokenFs => ({ ...nodeFs, ...fs });

const TOKEN_KEYS = ['clientId', 'accessToken', 'refreshToken', 'subject', 'expiresAt'] as const;
const STATE_KEYS = {
  ready: ['state', 'tokens'],
  pending: ['state', 'tokens', 'since'],
  spent: ['state', 'subject'],
} as const;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const instant = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && tokenText(max).test(value);

function planTokens(value: unknown): PlanTokens | undefined {
  if (!record(value) || !exactKeys(value, TOKEN_KEYS)) return undefined;
  const { clientId, accessToken, refreshToken, subject, expiresAt } = value;
  if (!text(clientId, FIELD_MAX.clientId) || !text(accessToken, FIELD_MAX.accessToken))
    return undefined;
  if (!text(refreshToken, FIELD_MAX.refreshToken) || !text(subject, FIELD_MAX.subject))
    return undefined;
  if (!instant(expiresAt)) return undefined;
  return { clientId, accessToken, refreshToken, subject, expiresAt };
}

/** The one shape check, for the encoder and the decoder alike. */
function tokenFile(value: unknown): TokenFile | undefined {
  if (!record(value)) return undefined;
  const { state } = value;
  if (state !== 'ready' && state !== 'pending' && state !== 'spent') return undefined;
  if (!exactKeys(value, STATE_KEYS[state])) return undefined;
  if (state === 'spent')
    return text(value['subject'], FIELD_MAX.subject)
      ? { state, subject: value['subject'] }
      : undefined;
  const tokens = planTokens(value['tokens']);
  if (tokens === undefined) return undefined;
  if (state === 'ready') return { state, tokens };
  return instant(value['since']) ? { state, tokens, since: value['since'] } : undefined;
}

/** The only encoder: exact keys, bounded fields, one fixed key order. */
export function encodeTokenFile(file: TokenFile): Buffer | 'TOO_LARGE' | 'NOT_TOKENS' {
  const valid = tokenFile(file);
  if (valid === undefined) return 'NOT_TOKENS';
  const ordered =
    valid.state === 'spent'
      ? { state: valid.state, subject: valid.subject }
      : {
          state: valid.state,
          tokens: Object.fromEntries(TOKEN_KEYS.map((key) => [key, valid.tokens[key]])),
          ...(valid.state === 'pending' ? { since: valid.since } : {}),
        };
  const bytes = Buffer.from(JSON.stringify(ordered), 'utf8');
  return bytes.length > TOKEN_FILE_BYTES ? 'TOO_LARGE' : bytes;
}

function decodeTokenFile(bytes: Buffer): TokenFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
  return tokenFile(parsed);
}

export const sha256 = (bytes: Buffer): Buffer => createHash('sha256').update(bytes).digest();

const stateDb = (path: string) => `${path}.state`;

/** True for the token file itself or P2's host registration file beside it, under a live hold. */
const governs = (held: HeldLock, path: string): boolean =>
  holds(held, held.path) &&
  (path === held.path || path === `${dirname(held.path)}/${HOST_REGISTRATION_FILE}`);

/** The committed digest each hold last read or wrote: its generation fence. */
const observed = new WeakMap<HeldLock, Buffer | undefined>();
const sameDigest = (a: Buffer | undefined, b: Buffer | undefined): boolean =>
  a === undefined ? b === undefined : b !== undefined && a.equals(b);

function digestRow(sqlite: DatabaseSync): Buffer | undefined {
  const table = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'committed'")
    .get();
  if (table === undefined) return undefined;
  const row = sqlite.prepare('SELECT digest FROM committed WHERE id = 1').get() as
    { digest?: unknown } | undefined;
  return row?.digest instanceof Uint8Array ? Buffer.from(row.digest) : undefined;
}

/**
 * The committed digest under the held lock: the bytes of the last record
 * whose commit succeeded, `undefined` when there is none, or `'failed'`.
 */
export function committedDigest(held: HeldLock, path: string): Buffer | undefined | 'failed' {
  if (!holds(held, path)) return 'failed';
  const db = stateDb(path);
  try {
    nodeFs.lstatSync(db);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'failed';
    observed.set(held, undefined);
    return undefined;
  }
  if (!privateFile(db)) return 'failed';
  let sqlite: DatabaseSync | undefined;
  try {
    sqlite = new DatabaseSync(db);
    sqlite.exec('PRAGMA busy_timeout = 0');
    const digest = digestRow(sqlite);
    observed.set(held, digest);
    return digest;
  } catch {
    return 'failed';
  } finally {
    sqlite?.close();
  }
}

function commitDigest(held: HeldLock, path: string, bytes: Buffer): boolean {
  const db = stateDb(path);
  if (!privateFile(db)) return false;
  let sqlite: DatabaseSync | undefined;
  try {
    sqlite = new DatabaseSync(db);
    sqlite.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = delete; PRAGMA synchronous = full');
    sqlite.exec(
      'CREATE TABLE IF NOT EXISTS committed (id INTEGER PRIMARY KEY CHECK (id = 1), digest BLOB NOT NULL)',
    );
    sqlite.exec('BEGIN IMMEDIATE');
    const current = digestRow(sqlite);
    // The fence, judged under this database's write lock: the hold is still
    // live on its lock inode, and nobody committed since this hold last looked.
    if (!holds(held, path) || (observed.has(held) && !sameDigest(observed.get(held), current)))
      throw new Error('fenced');
    const digest = sha256(bytes);
    sqlite
      .prepare(
        'INSERT INTO committed (id, digest) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET digest = excluded.digest',
      )
      .run(digest);
    sqlite.exec('COMMIT');
    observed.set(held, digest);
    return true;
  } catch {
    // A refused COMMIT leaves its transaction open; roll it back before close.
    try {
      if (sqlite?.isTransaction === true) sqlite.exec('ROLLBACK');
    } catch {
      // Close below discards it either way.
    }
    return false;
  } finally {
    sqlite?.close();
  }
}

const refused = (code: TokenFileRefusal) => ({ state: 'refused', code }) as const;

/** Every byte of `fd`, or `undefined` past TOKEN_FILE_BYTES (it reads one byte more at most). */
function readBounded(f: TokenFs, fd: number): Buffer | undefined {
  const buffer = Buffer.alloc(TOKEN_FILE_BYTES + 1);
  let length = 0;
  for (;;) {
    const read = f.readSync(fd, buffer, length, buffer.length - length, null);
    if (read === 0) return buffer.subarray(0, length);
    length += read;
    if (length === buffer.length) return undefined;
  }
}

/**
 * The visible bytes of the token file under the held lock, judged as a file:
 * owner-only, regular, not a symlink, the inode the `lstat` saw, and at most
 * TOKEN_FILE_BYTES. Not yet judged against the committed digest.
 */
export function readBytesLocked(
  held: HeldLock,
  path: string,
  fs: Partial<TokenFs> = {},
):
  | Buffer
  | { readonly state: 'absent' }
  | { readonly state: 'refused'; readonly code: TokenFileRefusal } {
  const f = files(fs);
  if (!governs(held, path)) return refused('SUBSCRIPTION_STORE_FAILED');
  let seen: nodeFs.Stats;
  try {
    seen = f.lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'absent' }
      : refused('SUBSCRIPTION_STORE_FAILED');
  }
  if (!seen.isFile() || seen.isSymbolicLink() || !ownerOnly(seen) || !aclFree(path))
    return refused('SUBSCRIPTION_TOKEN_FILE_OPEN');
  let fd: number;
  try {
    fd = f.openSync(path, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ELOOP'
      ? refused('SUBSCRIPTION_TOKEN_FILE_OPEN')
      : refused('SUBSCRIPTION_STORE_FAILED');
  }
  try {
    const opened = f.fstatSync(fd);
    if (
      opened.dev !== seen.dev ||
      opened.ino !== seen.ino ||
      !opened.isFile() ||
      !ownerOnly(opened)
    ) {
      return refused('SUBSCRIPTION_TOKEN_FILE_OPEN');
    }
    return readBounded(f, fd) ?? refused('SUBSCRIPTION_SIGN_IN_NEEDED');
  } catch {
    return refused('SUBSCRIPTION_STORE_FAILED');
  } finally {
    try {
      f.closeSync(fd);
    } catch {
      // A read-only descriptor; nothing was written through it.
    }
  }
}

/** The record under the held lock, acted on only when its bytes are the committed record. */
export function readTokenFileLocked(
  held: HeldLock,
  path: string,
  fs: Partial<TokenFs> = {},
): OnDisk {
  if (path !== held.path) return refused('SUBSCRIPTION_STORE_FAILED');
  sweepTokenCopies(held, path, fs);
  const bytes = readBytesLocked(held, path, fs);
  if (!Buffer.isBuffer(bytes)) {
    // An absent file still fences this hold to the generation it saw.
    if (bytes.state === 'absent' && committedDigest(held, path) === 'failed')
      return refused('SUBSCRIPTION_STORE_FAILED');
    return bytes;
  }
  const digest = committedDigest(held, path);
  if (digest === 'failed') return { state: 'refused', code: 'SUBSCRIPTION_STORE_FAILED' };
  if (digest === undefined || !digest.equals(sha256(bytes)))
    return { state: 'refused', code: 'SUBSCRIPTION_SIGN_IN_NEEDED' };
  return decodeTokenFile(bytes) ?? { state: 'refused', code: 'SUBSCRIPTION_SIGN_IN_NEEDED' };
}

function remove(f: TokenFs, path: string): void {
  try {
    f.rmSync(path, { force: true });
  } catch {
    // The next locked sweep removes it.
  }
}

function fsyncDirectory(f: TokenFs, dir: string): void {
  const fd = f.openSync(dir, 'r');
  try {
    f.fsyncSync(fd);
  } finally {
    f.closeSync(fd);
  }
}

/** Step 1: every byte in a fresh owner-only file, made durable, or no file at all. */
function writeDurably(f: TokenFs, next: string, bytes: Buffer): boolean {
  try {
    const fd = f.openSync(next, 'wx', 0o600);
    try {
      for (let at = 0; at < bytes.length;) at += f.writeSync(fd, bytes, at, bytes.length - at);
      f.fsyncSync(fd);
    } finally {
      f.closeSync(fd);
    }
    return true;
  } catch {
    remove(f, next);
    return false;
  }
}

function exists(f: TokenFs, path: string): boolean {
  try {
    f.lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Steps 1 to 5 of the commit protocol: a durable file at `path` or the old
 * file left in place. P2's host registration file uses this alone; `path` is
 * the token file or that one sibling, nothing else.
 */
export function commitBytes(
  held: HeldLock,
  path: string,
  bytes: Buffer,
  fs: Partial<TokenFs> = {},
): Exclude<CommitOutcome, 'unconfirmed' | 'TOO_LARGE' | 'NOT_TOKENS'> {
  if (!governs(held, path)) return 'unwritten';
  sweepTokenCopies(held, held.path, fs);
  const f = files(fs);
  const r = randomBytes(8).toString('hex');
  const next = `${path}.${r}.next`;
  const undo = `${path}.${r}.undo`;
  if (!writeDurably(f, next, bytes)) return 'unwritten';
  let prior: boolean;
  try {
    prior = exists(f, path);
    if (prior) f.linkSync(path, undo);
  } catch {
    remove(f, next);
    return 'unwritten';
  }
  try {
    f.renameSync(next, path);
  } catch {
    remove(f, next);
    remove(f, undo);
    return 'unwritten';
  }
  try {
    fsyncDirectory(f, dirname(path));
  } catch {
    try {
      if (prior) f.renameSync(undo, path);
      else f.unlinkSync(path);
    } catch {
      return 'exposed';
    }
    try {
      fsyncDirectory(f, dirname(path));
    } catch {
      // Best effort: the committed digest still names the prior record.
    }
    return 'reverted';
  }
  if (prior) remove(f, undo);
  return 'durable';
}

/** The full commit: a durable file, then its digest committed (step 6, the commit point). */
export function commitTokenFile(
  held: HeldLock,
  path: string,
  file: TokenFile,
  fs: Partial<TokenFs> = {},
): CommitOutcome {
  const bytes = encodeTokenFile(file);
  if (!Buffer.isBuffer(bytes)) return bytes;
  if (!holds(held, path)) return 'unwritten';
  const written = commitBytes(held, path, bytes, fs);
  if (written !== 'durable') return written;
  return commitDigest(held, path, bytes) ? 'durable' : 'unconfirmed';
}

/** Removes every transient `.next` and `.undo` copy of the token and host files; every locked read and write runs it first. */
export function sweepTokenCopies(held: HeldLock, path: string, fs: Partial<TokenFs> = {}): void {
  if (!holds(held, path)) return;
  const f = files(fs);
  const names = [basename(path), HOST_REGISTRATION_FILE];
  try {
    for (const entry of f.readdirSync(dirname(path))) {
      const name = names.find((n) => entry.startsWith(`${n}.`));
      const rest = name === undefined ? '' : entry.slice(name.length + 1);
      if (/^[0-9a-f]{16}\.(?:next|undo)$/u.test(rest)) remove(f, `${dirname(path)}/${entry}`);
    }
  } catch {
    // The next hold sweeps again.
  }
}
