// SPDX-License-Identifier: AGPL-3.0-only
//
// The two things a decision needs that are not in anybody's payload: the key
// the decision chain is signed with, and the cap the envelope draws on.
//
// Both are deployment facts, and both are deliberately unreachable from a
// request body. A caller who could name the signing key could sign a chain
// link with a key nobody trusts; a caller who could name the cap could draw on
// a ceiling somebody else's business was given. So the key comes from the
// process environment and the cap is read from the business the serving
// transaction is already inside.
//
// **Why the key is not in the database.** `gate_decisions.signing_key_id` is
// stored beside every link so a verifier can say which key signed it, and the
// secret is what makes the signature worth anything. A secret in a table the
// application role can read is a secret every SQL injection reaches, and the
// chain it protects is the one record this slice treats as append-only.
// `signing.ts` names HMAC as the custody choice a real signer replaces behind
// `sign`/`verify`; this is the same seam one layer up.

import type { TenantQuery } from '../tenancy/database.ts';
import type { SigningKey } from '../../../core-runtime/src/signing.ts';

/** The key this deployment signs decision links with, or nothing if unconfigured. */
export function gateSigningKey(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SigningKey | undefined {
  const id = environment['GATE_SIGNING_KEY_ID'];
  const secret = environment['GATE_SIGNING_SECRET'];
  if (id === undefined || id === '' || secret === undefined || secret === '') return undefined;
  return { id, secret };
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
  const rows = await tx.query<{ readonly id: string }>(
    `select id from public.budget_caps
      where business_id = $1
      order by (key = $2) desc, created_at
      limit 1`,
    [tx.businessId, LOCAL_CAP_KEY],
  );
  return rows[0]?.id;
}
