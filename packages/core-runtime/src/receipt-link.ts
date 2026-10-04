// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08: the receipt link, captured from the provider's answer when the effect
// is observed (publish time), and kept only when it is plainly a page on the
// operation's declared host. Anything else is recorded as absent and never
// rendered as a link. A link resolved later is not a receipt.
//
// Kept: `https:`, the declared host exactly, no user, password or port, no
// query or fragment (where tokens ride), at most `RECEIPT_LINK_MAX` characters,
// the parsed form byte for byte the bytes sent, and the column's own shape
// (`RECEIPT_LINK_SHAPE`, migration 0109). The byte rule refuses what the URL
// parser would quietly repair: tabs and newlines it strips, backslashes it
// turns, case it folds, and dot segments it resolves. The shape rule refuses
// what the parser keeps but the column would not ('|', '[', ']'), so such a
// link is recorded absent and never fails the observation. The credential rule
// refuses a link whose text, as sent or once its percent escapes are decoded
// (either case, as often as they decode), holds a run as long as a delegation
// credential (`CREDENTIAL_RUN`), or, for an agent's observation, the letters
// and digits of that agent's own credential in order with anything between
// them dropped, so its standard base64 spelling or a copy split by separators
// is refused too (`presentedCredential`). A credential copied into a path is
// recorded absent, never stored or shown.

import { DERIVED_SCHEME, type TenantQuery } from '../../core-records/src/index.ts';
import { delegationCredentialKeys } from './runtime-config.ts';

/** The host each effect operation's receipt link may name, by step kind. */
export const EFFECT_RECEIPT_HOSTS: Readonly<Record<string, string>> = {
  synthetic_comment: 'receipts.stand-in.invalid',
};

export const RECEIPT_LINK_MAX = 512;

/** The shape `attempts_receipt_link_shape` (migration 0109) stores: exactly its pattern. */
export const RECEIPT_LINK_SHAPE: RegExp =
  /^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*$/u;

/**
 * A run of base64url characters as long as a delegation credential, an
 * HMAC-SHA-256 in base64url (`credential-keys.ts`): 43 characters. A UUID
 * (36) or an ordinary id is shorter.
 */
export const CREDENTIAL_RUN: RegExp = /[A-Za-z0-9_-]{43}/u;

/** Letters and digits only: what survives any re-spelling of a base64 credential. */
const alphanumerics = (text: string): string => text.replaceAll(/[^A-Za-z0-9]/gu, '');

/**
 * Whether the link, as sent or decoded, holds a credential-length run or the
 * presenter's credential. Each decode that changes the text shortens it, so
 * the loop ends; an escape that does not decode is refused with it.
 */
function carriesCredential(link: string, presented: string | undefined): boolean {
  const own = presented === undefined ? undefined : alphanumerics(presented);
  let text = link;
  for (;;) {
    if (CREDENTIAL_RUN.test(text)) return true;
    if (own !== undefined && alphanumerics(text).includes(own)) return true;
    let decoded: string;
    try {
      decoded = decodeURIComponent(text);
    } catch {
      return true;
    }
    if (decoded === text) return false;
    text = decoded;
  }
}

/** The link to keep, or `null`: absent, malformed, off the step's declared host or carrying a credential. */
export function receiptLinkOf(raw: unknown, stepKind: string, presented?: string): string | null {
  const host = Object.hasOwn(EFFECT_RECEIPT_HOSTS, stepKind)
    ? EFFECT_RECEIPT_HOSTS[stepKind]
    : undefined;
  if (host === undefined || typeof raw !== 'string' || raw.length > RECEIPT_LINK_MAX) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const plain =
    url.protocol === 'https:' &&
    url.hostname === host &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    url.search === '' &&
    url.hash === '' &&
    url.href === raw &&
    RECEIPT_LINK_SHAPE.test(raw) &&
    !carriesCredential(raw, presented);
  return plain ? raw : null;
}

/**
 * The credential an agent's observation was presented with, derived again from
 * its delegation's fixed identity under the key it names, as a pickup replay
 * does (`agent-replay.ts`). `null` when there is no delegation (a person's
 * observation); `undefined` when it cannot be derived here, and then no link
 * is kept.
 */
export async function presentedCredential(
  tx: TenantQuery,
  delegationId: string | null,
): Promise<string | null | undefined> {
  if (delegationId === null) return null;
  const [row] = await tx.query<{
    agent_actor_id: string;
    credential_key_id: string | null;
    credential_scheme: string;
  }>(
    `select agent_actor_id, credential_key_id, credential_scheme
       from public.delegations where business_id = $1 and id = $2`,
    [tx.businessId, delegationId],
  );
  const keys = delegationCredentialKeys();
  if (row?.credential_scheme !== DERIVED_SCHEME || row.credential_key_id === null || !keys.ok) {
    return undefined;
  }
  return keys.keys.derive(row.credential_key_id, {
    businessId: tx.businessId,
    agentActorId: row.agent_actor_id,
    delegationId,
  });
}
