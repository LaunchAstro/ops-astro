// SPDX-License-Identifier: AGPL-3.0-only
//
// The key a delegation credential is derived from, and the one place its
// bytes are handled.
//
// **Why a credential is derived rather than drawn.** A pickup returns its
// credential once, and the delegation keeps only the digest. If that response
// is lost, the committed receipt names a lease the claimant can no longer use,
// and a retry may not mint a second one (T3). A random token cannot be
// recovered from its digest. So a new delegation's credential is an HMAC of
// the delegation's own fixed identity under a server key. A replay that has
// passed the current-rights checks recomputes it and checks the digest before
// returning it. The register row, the delegation row and the audit never hold
// the token.
//
// **What goes into the derivation, and what stays out.** The domain and
// version, the key id, the business, the agent and the delegation id are
// JSON-encoded as one array, so no two inputs can run together. Expiry,
// grants, purpose wording and heartbeat state are left out: they change after
// the token was delivered, and changing them must not change it.
//
// **Custody.** The key is not the gate-signing key and not the Supabase JWT
// secret. It lives outside the database and outside tracked files: in the
// environment, or in a gitignored 0600 file that is created once and then only
// read. Each file gets a fresh random key id when it is written, so a key that
// was lost and regenerated can never sit under an id an older delegation
// names. That delegation then fails closed as a missing key; it never
// validates against the wrong bytes. A database restore needs this key backed
// up with it, and every process serving one database needs the same keyring.
//
// **Legacy rows.** Delegations minted before this scheme carry
// `credential_scheme = 'legacy-random'`. Their tokens are still valid when
// presented, and cannot be recovered from their digests. Nothing here
// relabels them.

import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The scheme a derivable delegation records. Frozen with the encoding below. */
export const DERIVED_SCHEME = 'hmac-sha256-v1';

/** The scheme every delegation minted before derivation carries. Never derivable. */
export const LEGACY_SCHEME = 'legacy-random';

/** The domain and version, first in the encoding. Changing it changes every credential. */
export const CREDENTIAL_DOMAIN = 'ops-astro/delegation-credential/v1';

/** The environment names a deployment configures its keyring with. */
export const ACTIVE_KEY_VARIABLE = 'DELEGATION_CREDENTIAL_KEY_ID';
export const KEYRING_VARIABLE = 'DELEGATION_CREDENTIAL_KEYS';
export const KEY_FILE_VARIABLE = 'DELEGATION_CREDENTIAL_KEY_FILE';

const MINIMUM_KEY_BYTES = 32;
const KEY_ID = /^[A-Za-z0-9._@/-]{1,64}$/u;

/** The fixed identity a credential is derived from. None of it changes after minting. */
export interface CredentialIdentity {
  readonly businessId: string;
  readonly agentActorId: string;
  readonly delegationId: string;
}

/**
 * The narrow interface minting and replay depend on.
 *
 * It never hands out key bytes. It names the key new mints use and derives
 * under a named key, answering `undefined` when this process does not hold
 * that key.
 */
export interface DelegationCredentialKeys {
  readonly activeKeyId: string;
  derive(keyId: string, identity: CredentialIdentity): string | undefined;
}

/** The keyring, or why this process has none it may use. Never thrown. */
export type CredentialKeysDecision =
  | { readonly ok: true; readonly keys: DelegationCredentialKeys }
  | { readonly ok: false; readonly problem: string };

/** The exact bytes the HMAC is computed over. Exported so the encoding can be asserted. */
export function credentialEncoding(keyId: string, identity: CredentialIdentity): string {
  return JSON.stringify([
    CREDENTIAL_DOMAIN,
    keyId,
    identity.businessId,
    identity.agentActorId,
    identity.delegationId,
  ]);
}

/** A keyring over bytes already validated. The map is copied and never exposed. */
export function credentialKeyring(
  activeKeyId: string,
  keys: ReadonlyMap<string, Buffer>,
): DelegationCredentialKeys {
  const held = new Map(keys);
  return {
    activeKeyId,
    derive(keyId, identity) {
      const key = held.get(keyId);
      if (key === undefined) return undefined;
      return createHmac('sha256', key)
        .update(credentialEncoding(keyId, identity), 'utf8')
        .digest('base64url');
    },
  };
}

/**
 * The keyring from its two settings: the active id, and `id:base64url` pairs
 * separated by commas.
 *
 * Malformed is refused rather than repaired. A short key, a key that is not
 * canonical base64url, a repeated id or an active id with no key each leave
 * this process with no keyring, so pickups refuse instead of minting under a
 * key nobody meant.
 */
export function parseCredentialKeys(
  activeKeyId: string | undefined,
  keyring: string | undefined,
): CredentialKeysDecision {
  if (activeKeyId === undefined || activeKeyId === '') {
    return { ok: false, problem: `${ACTIVE_KEY_VARIABLE} is not set` };
  }
  if (keyring === undefined || keyring === '') {
    return { ok: false, problem: `${KEYRING_VARIABLE} is not set` };
  }
  const keys = new Map<string, Buffer>();
  for (const entry of keyring.split(',')) {
    const at = entry.indexOf(':');
    const id = at === -1 ? '' : entry.slice(0, at).trim();
    const encoded = at === -1 ? '' : entry.slice(at + 1).trim();
    if (!KEY_ID.test(id)) {
      return { ok: false, problem: `${KEYRING_VARIABLE} has an entry with no valid key id` };
    }
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.length < MINIMUM_KEY_BYTES || bytes.toString('base64url') !== encoded) {
      return {
        ok: false,
        problem: `${KEYRING_VARIABLE} key ${id} is not at least ${String(MINIMUM_KEY_BYTES)} bytes of base64url`,
      };
    }
    if (keys.has(id)) {
      return { ok: false, problem: `${KEYRING_VARIABLE} names key ${id} twice` };
    }
    keys.set(id, bytes);
  }
  if (!keys.has(activeKeyId)) {
    return {
      ok: false,
      problem: `${ACTIVE_KEY_VARIABLE} names ${activeKeyId}, which the keyring lacks`,
    };
  }
  return { ok: true, keys: credentialKeyring(activeKeyId, keys) };
}

function readKeyFile(file: string): CredentialKeysDecision {
  const text = readFileSync(file, 'utf8');
  const value = (name: string): string | undefined =>
    new RegExp(`^${name}=(.*)$`, 'mu').exec(text)?.[1]?.trim();
  const decision = parseCredentialKeys(value(ACTIVE_KEY_VARIABLE), value(KEYRING_VARIABLE));
  return decision.ok ? decision : { ok: false, problem: `${file}: ${decision.problem}` };
}

/**
 * The local key file, created on first use and only read afterwards.
 *
 * Created by writing a private temporary file and hard-linking it into place,
 * which fails if the file exists. Two processes starting together therefore
 * agree on one key, and a reader never sees a half-written file. An existing
 * file is never rewritten, even when it is malformed: that is a refusal
 * for a person to look at, because the key in it may be the one every live
 * delegation was minted under.
 */
export function ensureCredentialKeyFile(file: string): CredentialKeysDecision {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    const keyId = `local/delegation-credential@${randomBytes(6).toString('hex')}`;
    const key = randomBytes(MINIMUM_KEY_BYTES).toString('base64url');
    const staging = `${file}.${String(process.pid)}.${randomBytes(4).toString('hex')}`;
    writeFileSync(
      staging,
      `# Delegation credential keyring. Local only, gitignored, back it up with the database.\n` +
        `# Never replace the bytes under an existing id. Rotate by adding a key and moving the active id.\n` +
        `${ACTIVE_KEY_VARIABLE}=${keyId}\n${KEYRING_VARIABLE}=${keyId}:${key}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    try {
      linkSync(staging, file);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    } finally {
      unlinkSync(staging);
    }
  }
  return readKeyFile(file);
}

/** The repository's own gitignored key file. */
export const LOCAL_KEY_FILE: string = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '.local',
  'delegation.env',
);

/**
 * This process's keyring.
 *
 * Explicit configuration wins, and once either setting is present the file
 * is not consulted: a deployment that configured half a keyring has a
 * configuration fault, not a fallback. With neither setting, the local key
 * file is used and created if it is absent.
 */
export function configuredCredentialKeys(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CredentialKeysDecision {
  const active = environment[ACTIVE_KEY_VARIABLE];
  const keyring = environment[KEYRING_VARIABLE];
  if ((active ?? '') !== '' || (keyring ?? '') !== '') {
    return parseCredentialKeys(active, keyring);
  }
  const file = environment[KEY_FILE_VARIABLE];
  return ensureCredentialKeyFile(file === undefined || file === '' ? LOCAL_KEY_FILE : file);
}
