// SPDX-License-Identifier: AGPL-3.0-only
//
// The two things a decision needs that are not in anybody's payload: the key
// the decision chain is signed with, and the cap the envelope draws on.
//
// Both are deployment facts, and both are deliberately unreachable from a
// request body. A caller who could name the signing key could sign a chain
// link with a key nobody trusts; a caller who could name the cap could draw on
// a ceiling somebody else's business was given. So the keys are handed over as
// values (`withRuntimeKeys`), never through `process.env`, which child processes
// inherit, and the cap is read from the business the transaction is inside.
//
// **Why the key is not in the database.** `gate_decisions.signing_key_id` is
// stored beside every link so a verifier can say which key signed it, and the
// secret is what makes the signature worth anything. A secret in a table the
// application role can read is a secret every SQL injection reaches, and the
// chain it protects is the one record this slice treats as append-only.
// `signing.ts` names HMAC as the custody choice a real signer replaces behind
// `sign`/`verify`; this is the same seam one layer up.

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  configuredCredentialKeys,
  loadSealingKey,
  withCredentialKeys,
} from '../../core-records/src/index.ts';
import type {
  TenantQuery,
  CredentialKeysDecision,
  SealingKey,
} from '../../core-records/src/index.ts';
import { keyResolver, type KeyResolver, type SigningKey } from './signing.ts';

type Settings = Readonly<Record<string, string | undefined>>;

/** Both deployment keys, read once by a composition root. */
export interface RuntimeKeys {
  readonly gate: SigningKey | undefined;
  /** The keys a read verifies decision links with: `gate` and every retained key. */
  readonly gateVerifying: GateVerifyingKeysDecision;
  readonly delegation: CredentialKeysDecision;
  /** The broker's public key custody seals to (C31); the application never holds the private half. */
  readonly custody: SealingKey | undefined;
}

export function runtimeKeys(settings: Settings): RuntimeKeys {
  return {
    gate: gateSigningKey(settings),
    gateVerifying: gateVerifyingKeys(settings),
    delegation: configuredCredentialKeys(settings),
    custody: loadSealingKey(settings),
  };
}

/**
 * Why a composition root must not start with these keys, or nothing: a
 * malformed delegation keyring or retained gate key setting. It names the
 * setting, never a key's bytes.
 */
export function runtimeKeysProblem(keys: RuntimeKeys): string | undefined {
  if (!keys.delegation.ok) return `delegation credential keys: ${keys.delegation.problem}`;
  if (!keys.gateVerifying.ok) return `gate keys: ${keys.gateVerifying.problem}`;
  return undefined;
}

const handedOver = new AsyncLocalStorage<RuntimeKeys>();

/**
 * Runs `run` with the keys its commands and reads use, the keyring also where
 * the runtime's own mint reads it. A composed app runs each request so, and two
 * apps in one process keep their own. Outside one, a test or a script reads
 * its own `process.env` instead.
 */
export function withRuntimeKeys<T>(keys: RuntimeKeys, run: () => T): T {
  return handedOver.run(keys, () => withCredentialKeys(keys.delegation, run));
}

/** The key custody seals a secret to, or nothing if unconfigured: `secret.set` then refuses. */
export function custodySealingKey(): SealingKey | undefined {
  const held = handedOver.getStore();
  return held === undefined ? loadSealingKey(process.env) : held.custody;
}

/** The key this deployment signs decision links with, or nothing if unconfigured. */
export function gateSigningKey(settings?: Settings): SigningKey | undefined {
  const held = settings === undefined ? handedOver.getStore() : undefined;
  if (held !== undefined) return held.gate;
  const environment = settings ?? process.env;
  const id = environment['GATE_SIGNING_KEY_ID'];
  const secret = environment['GATE_SIGNING_SECRET'];
  if (id === undefined || id === '' || secret === undefined || secret === '') return undefined;
  return { id, secret };
}

/** The setting that names retired gate keys, as a JSON array of `{"id","secret"}`. */
export const RETAINED_GATE_KEYS_VARIABLE = 'GATE_RETAINED_KEYS';

/**
 * The keys a read verifies decision links with, or why the setting was
 * refused. `keys` is `null` when no signing key is configured. Never thrown.
 */
export type GateVerifyingKeysDecision =
  | { readonly ok: true; readonly keys: KeyResolver | null }
  | { readonly ok: false; readonly problem: string };

/**
 * The signing key and every key `GATE_RETAINED_KEYS` retains (#2265).
 *
 * A business's chain outlives the key that signed its first links, and each
 * row names the key it was signed under, so a read verifies an older row with
 * the retired key its row names. A retained key only verifies: `gateSigningKey`
 * stays the one key a decision is signed with. Malformed is refused rather
 * than skipped, as the delegation keyring is, and the problem names the
 * setting and the entry, never a secret.
 */
export function gateVerifyingKeys(settings?: Settings): GateVerifyingKeysDecision {
  const held = settings === undefined ? handedOver.getStore() : undefined;
  if (held !== undefined) return held.gateVerifying;
  const environment = settings ?? process.env;
  const signing = gateSigningKey(environment);
  const retained = parseRetainedGateKeys(environment[RETAINED_GATE_KEYS_VARIABLE]);
  if (!retained.ok) return retained;
  if (retained.keys.length > 0 && signing === undefined) {
    return refuseRetained('is set but GATE_SIGNING_KEY_ID and GATE_SIGNING_SECRET are not');
  }
  if (signing === undefined) return { ok: true, keys: null };
  if (retained.keys.some((key) => key.id === signing.id)) {
    return refuseRetained('repeats the signing key id');
  }
  return { ok: true, keys: keyResolver([signing, ...retained.keys]) };
}

function refuseRetained(problem: string): { readonly ok: false; readonly problem: string } {
  return { ok: false, problem: `${RETAINED_GATE_KEYS_VARIABLE} ${problem}` };
}

function parseRetainedGateKeys(
  text: string | undefined,
):
  | { readonly ok: true; readonly keys: readonly SigningKey[] }
  | { readonly ok: false; readonly problem: string } {
  if (text === undefined || text.trim() === '') return { ok: true, keys: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuseRetained('is not JSON');
  }
  if (!Array.isArray(parsed)) return refuseRetained('is not a JSON array');
  const keys: SigningKey[] = [];
  for (const [index, entry] of (parsed as unknown[]).entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return refuseRetained(`entry ${index} is not an object`);
    }
    const fields = entry as Record<string, unknown>;
    if (Object.keys(fields).some((name) => name !== 'id' && name !== 'secret')) {
      return refuseRetained(`entry ${index} has a field other than id and secret`);
    }
    const { id, secret } = fields;
    if (typeof id !== 'string' || id === '') {
      return refuseRetained(`entry ${index} has no id`);
    }
    if (typeof secret !== 'string' || secret === '') {
      return refuseRetained(`entry ${index} has no secret`);
    }
    if (keys.some((key) => key.id === id)) {
      return refuseRetained(`entry ${index} repeats a key id`);
    }
    keys.push({ id, secret });
  }
  return { ok: true, keys };
}

/**
 * The keyring delegation credentials are derived under, or why there is none.
 *
 * A third deployment secret beside the two above, and deliberately not either
 * of them: the gate key signs decisions and the JWT secret verifies logins, and
 * a leak of one should not let anybody compute a delegation credential. The
 * same custody argument as the signing key's applies. The bytes stay out of
 * every table, so the digest in `delegations.credential_hash` is only worth
 * something with a key the database does not hold. `DELEGATION_CREDENTIAL_KEY_ID`
 * and `DELEGATION_CREDENTIAL_KEYS` configure it explicitly. Without them it is
 * the gitignored `.local/delegation.env`, which is created once and never
 * rewritten (`authority/credential-keys.ts`).
 */
export function delegationCredentialKeys(): CredentialKeysDecision {
  return configuredCredentialKeys();
}

/**
 * The business's own budget cap.
 *
 * One per business in this head, seeded under the key below. It is read rather
 * than created: a command that created the ceiling it then spent against would
 * be a command that cannot be refused `BUDGET_EXHAUSTED`, and the cap's
 * refusal being the cap's is W05's whole point.
 */
export const LOCAL_CAP_KEY = 'local';

export async function readBusinessCapId(tx: TenantQuery): Promise<string | undefined> {
  // One cap per business in this head. The `local` one is preferred by name so
  // that a business which grows a second cap does not silently start drawing
  // on whichever was inserted first, and the fallback is the oldest rather
  // than an error: a business with exactly one cap under any key is the
  // ordinary case and refusing it would be refusing a correct installation.
  // The `planning` cap is never a task's: it is AW-04's planning chat's own
  // allowance, and its first reply writes it (`core-custody/src/broker-planning.ts`).
  const rows = await tx.query<{ readonly id: string }>(
    `select id from public.budget_caps
      where business_id = $1 and key <> 'planning'
      order by (key = $2) desc, created_at
      limit 1`,
    [tx.businessId, LOCAL_CAP_KEY],
  );
  return rows[0]?.id;
}
