// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's plan sign-in, custody's half (#1620 P2): the host registration
// file beside the token file, and the two holds of the plan token lock a
// sign-in takes. Nothing here touches the network; the browser flow, the code
// exchange and the ID token check are the model agent's
// (`apps/model-agent/chatgpt-sign-in.ts`), and no lock is held while they run.
//
// `chatgpt-host.json` is either host-only, `{ extAgentHostId }`, which
// permits one registration for that host id, or registered,
// `{ extAgentHostId, clientId }`, which permits only grants for that client
// id. It is not a secret and has no committed digest: its visible bytes are
// the record.
//
// The start hold refuses a token file the owner must look at, and reads or
// makes the host id. The final hold judges everything again from scratch,
// after its own lock wait: the account (`signInVerdict`), then the
// registration, then it writes the registration (a first sign-in only) and
// the token record. Only `durable` counts as signed in. A store that did not
// happen leaves no copy of the new tokens: its transient copies are swept and
// its own uncommitted bytes removed, inside the same hold.

import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { dirname, join } from 'node:path';
import { signInVerdict } from './plan-token.ts';
import {
  HOST_REGISTRATION_FILE,
  commitBytes,
  commitTokenFile,
  encodeTokenFile,
  readBytesLocked,
  readTokenFileLocked,
  tokenText,
  FIELD_MAX,
  type PlanTokens,
  type TokenFs,
} from './token-file.ts';
import { withTokenLock, type HeldLock } from './token-lock.ts';

/** How long either hold waits for the lock: a refresh holds it 30 s at most, plus its file calls. */
export const SIGN_IN_LOCK_WAIT_MS = 45_000;

export type SignInStoreRefusal =
  | 'SIGN_IN_ACCOUNT_CHANGED'
  | 'SIGN_IN_FILE_NEEDS_OWNER'
  | 'SIGN_IN_HOST_FILE_NEEDS_OWNER'
  | 'SIGN_IN_REGISTRATION_CHANGED'
  | 'SIGN_IN_TOKENS_UNUSABLE'
  | 'SIGN_IN_STORE_FAILED';

/** What the start hold read: the host id to send, and the client id a later sign-in reuses. */
export interface SignInAsk {
  readonly hostId: string;
  /** Absent on a first sign-in, which registers. */
  readonly clientId: string | undefined;
}

export interface SignInStoreOptions {
  readonly file: string;
  readonly now?: () => number;
  /** Fault injection for tests; production passes nothing. */
  readonly fs?: Partial<TokenFs>;
}

type Refused = { readonly ok: false; readonly code: SignInStoreRefusal };
const refuse = (code: SignInStoreRefusal): Refused => ({ ok: false, code });

const HOST_ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** An issued client id: never the registration entrypoint, and storable in the token file. */
export const issuedClientId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[\w-]{1,200}$/u.test(value) &&
  value !== 'dynamic_agent_client' &&
  tokenText(FIELD_MAX.clientId).test(value);

interface Registration {
  readonly extAgentHostId: string;
  readonly clientId?: string;
}

const hostPath = (file: string): string => join(dirname(file), HOST_REGISTRATION_FILE);

const encodeHost = (registration: Registration): Buffer =>
  Buffer.from(
    JSON.stringify(
      registration.clientId === undefined
        ? { extAgentHostId: registration.extAgentHostId }
        : { extAgentHostId: registration.extAgentHostId, clientId: registration.clientId },
    ),
    'utf8',
  );

/** The host file's record, exact keys only; anything else is undefined. */
function decodeHost(bytes: Buffer): Registration | undefined {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { extAgentHostId, clientId, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof extAgentHostId !== 'string') return undefined;
  if (!HOST_ID.test(extAgentHostId)) return undefined;
  if (clientId === undefined && !Object.hasOwn(value, 'clientId')) return { extAgentHostId };
  return issuedClientId(clientId) ? { extAgentHostId, clientId } : undefined;
}

/** The host file under the held lock: absent, its record, or unusable. */
function readHost(
  held: HeldLock,
  file: string,
  fs: Partial<TokenFs>,
): Registration | 'absent' | 'unusable' {
  const bytes = readBytesLocked(held, hostPath(file), fs);
  if (!Buffer.isBuffer(bytes)) return bytes.state === 'absent' ? 'absent' : 'unusable';
  return decodeHost(bytes) ?? 'unusable';
}

async function hold<T>(
  options: SignInStoreOptions,
  work: (held: HeldLock) => T | Refused,
): Promise<T | Refused> {
  const now = options.now ?? Date.now;
  try {
    const out = await withTokenLock(
      options.file,
      { deadlineAt: now() + SIGN_IN_LOCK_WAIT_MS, now },
      (held) => Promise.resolve(work(held)),
    );
    return out.held ? out.value : refuse('SIGN_IN_STORE_FAILED');
  } catch {
    return refuse('SIGN_IN_STORE_FAILED');
  }
}

/**
 * The start hold, before the browser opens: a token file the owner must look
 * at is refused, and the host id is read, or made and written host-only.
 */
export async function beginSignIn(
  options: SignInStoreOptions,
): Promise<({ readonly ok: true } & SignInAsk) | Refused> {
  const { file } = options;
  const fs = options.fs ?? {};
  return await hold(options, (held) => {
    if (readTokenFileLocked(held, file, fs).state === 'refused')
      return refuse('SIGN_IN_FILE_NEEDS_OWNER');
    const host = readHost(held, file, fs);
    if (host === 'unusable') return refuse('SIGN_IN_HOST_FILE_NEEDS_OWNER');
    if (host !== 'absent')
      return { ok: true, hostId: host.extAgentHostId, clientId: host.clientId } as const;
    const made = { extAgentHostId: `urn:uuid:${randomUUID()}` };
    if (commitBytes(held, hostPath(file), encodeHost(made), fs) !== 'durable')
      return refuse('SIGN_IN_STORE_FAILED');
    return { ok: true, hostId: made.extAgentHostId, clientId: undefined } as const;
  });
}

/**
 * The registration judged under the final hold: a host-only file permits the
 * first sign-in's own grant for its host id; a registered file permits only
 * its own client id. Answers the record to write, if any.
 */
function judgeRegistration(
  host: Registration | 'absent' | 'unusable',
  ask: SignInAsk,
  clientId: string,
): Registration | 'unchanged' | Refused {
  if (host === 'unusable') return refuse('SIGN_IN_HOST_FILE_NEEDS_OWNER');
  if (host === 'absent' || host.extAgentHostId !== ask.hostId)
    return refuse('SIGN_IN_REGISTRATION_CHANGED');
  if (host.clientId !== undefined)
    return host.clientId === clientId ? 'unchanged' : refuse('SIGN_IN_REGISTRATION_CHANGED');
  if (ask.clientId !== undefined) return refuse('SIGN_IN_REGISTRATION_CHANGED');
  return { extAgentHostId: host.extAgentHostId, clientId };
}

/** Removes the new record's bytes when a store left them visible but uncommitted. */
function withdraw(held: HeldLock, file: string, bytes: Buffer, fs: Partial<TokenFs>): void {
  // The locked read sweeps the transient copies on its way in.
  const visible = readBytesLocked(held, file, fs);
  if (!Buffer.isBuffer(visible) || !visible.equals(bytes)) return;
  try {
    ({ ...nodeFs, ...fs }).rmSync(file, { force: true });
  } catch {
    // The committed digest still refuses these bytes.
  }
}

/**
 * The final hold, after the grant and its ID token were judged: the account
 * and the registration again, then the registration and the token record
 * written in this hold. `ok` only when the token record is durable.
 */
export async function storeSignIn(
  options: SignInStoreOptions,
  ask: SignInAsk,
  tokens: PlanTokens,
): Promise<{ readonly ok: true } | Refused> {
  const { file } = options;
  const fs = options.fs ?? {};
  const bytes = encodeTokenFile({ state: 'ready', tokens });
  if (!Buffer.isBuffer(bytes) || !issuedClientId(tokens.clientId))
    return refuse('SIGN_IN_TOKENS_UNUSABLE');
  return await hold(options, (held) => {
    const verdict = signInVerdict(readTokenFileLocked(held, file, fs), tokens.subject);
    if (verdict === 'SIGN_IN_OTHER_ACCOUNT') return refuse('SIGN_IN_ACCOUNT_CHANGED');
    if (verdict !== 'write') return refuse(verdict);
    const registration = judgeRegistration(readHost(held, file, fs), ask, tokens.clientId);
    if (registration !== 'unchanged' && 'ok' in registration) return registration;
    if (
      registration !== 'unchanged' &&
      commitBytes(held, hostPath(file), encodeHost(registration), fs) !== 'durable'
    )
      return refuse('SIGN_IN_STORE_FAILED');
    if (commitTokenFile(held, file, { state: 'ready', tokens }, fs) === 'durable')
      return { ok: true } as const;
    withdraw(held, file, bytes, fs);
    return refuse('SIGN_IN_STORE_FAILED');
  });
}
