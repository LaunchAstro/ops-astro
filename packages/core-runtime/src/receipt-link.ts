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
// and digits of any live credential that agent holds (its delegations, their
// children, its logins) in order with anything between them dropped, so a standard base64 spelling or a copy split
// by separators is refused too (`agentCredentials`). A credential copied into
// a path is recorded absent, never stored or shown.

import {
  deriveAgentCredential,
  DERIVED_SCHEME,
  type DelegationCredentialKeys,
  type TenantQuery,
} from '../../core-records/src/index.ts';
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
 * (36) or an ordinary id is shorter, but a run of 43 or more inside a longer
 * one is refused too (a long hyphenated slug, an id joined to a suffix): a
 * credential glued to other characters still counts, and a refused link costs
 * only the link. Revisit when a real provider's host is declared.
 */
export const CREDENTIAL_RUN: RegExp = /[A-Za-z0-9_-]{43}/u;

/** Letters and digits only: what survives any re-spelling of a base64 credential. */
const alphanumerics = (text: string): string => text.replaceAll(/[^A-Za-z0-9]/gu, '');

/**
 * A held credential's letters and digits, forwards and reversed, and its bytes
 * in lowercase hex. Best effort: an agent set on leaking its credential has
 * other ways out; this catches the re-spellings a provider or a careless
 * worker would make.
 */
const spellingsOf = (credential: string): readonly string[] => {
  const letters = alphanumerics(credential);
  return [
    letters,
    [...letters].toReversed().join(''),
    Buffer.from(credential, 'base64url').toString('hex'),
  ];
};

/**
 * Whether the link, as sent or decoded, holds a credential-length run or one
 * of the observing agent's credentials. Each decode that changes the text
 * shortens it, so the loop ends; an escape that does not decode is refused.
 */
function carriesCredential(link: string, held: readonly string[]): boolean {
  const own = held.flatMap((credential) => spellingsOf(credential));
  let text = link;
  for (;;) {
    if (CREDENTIAL_RUN.test(text)) return true;
    const letters = alphanumerics(text);
    const lower = letters.toLowerCase();
    if (own.some((spelling) => letters.includes(spelling) || lower.includes(spelling))) {
      return true;
    }
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
export function receiptLinkOf(
  raw: unknown,
  stepKind: string,
  held: readonly string[] = [],
): string | null {
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
    !carriesCredential(raw, held);
  return plain ? raw : null;
}

interface HeldRow {
  readonly id: string;
  readonly agent_actor_id: string;
  readonly credential_key_id: string | null;
  readonly credential_scheme: string;
  readonly login: boolean;
}

/** The observer's live delegations, the live children they minted, and its live logins; expired ones are no working token. */
async function heldRows(tx: TenantQuery, delegationId: string): Promise<readonly HeldRow[]> {
  return await tx.query<HeldRow>(
    `with observer as (
       select agent_actor_id from public.delegations where business_id = $1 and id = $2
     ), own as (
       select d.id, d.agent_actor_id, d.credential_key_id, d.credential_scheme
         from public.delegations d join observer o on o.agent_actor_id = d.agent_actor_id
        where d.business_id = $1 and d.revoked_at is null and d.settled_at is null
          and d.expires_at > now()
     )
     select id, agent_actor_id, credential_key_id, credential_scheme, false as login from own
     union all
     select c.id, c.agent_actor_id, c.credential_key_id, c.credential_scheme, false
       from public.delegations c
      where c.business_id = $1 and c.parent_delegation_id in (select id from own)
        and c.revoked_at is null and c.settled_at is null and c.expires_at > now()
     union all
     select a.id, a.agent_actor_id, a.credential_key_id, a.credential_scheme, true
       from public.agent_credentials a join observer o on o.agent_actor_id = a.agent_actor_id
      where a.business_id = $1 and a.revoked_at is null and a.expires_at > now()`,
    [tx.businessId, delegationId],
  );
}

/** One row's credential, derived again under the key it names, or undefined without it. */
function derivedFrom(
  keys: DelegationCredentialKeys,
  businessId: string,
  row: HeldRow,
): string | undefined {
  const keyId = row.credential_key_id;
  if (row.credential_scheme !== DERIVED_SCHEME || keyId === null) return undefined;
  if (row.login) {
    return deriveAgentCredential(keys, keyId, businessId, {
      id: row.id,
      agentActorId: row.agent_actor_id,
    });
  }
  return keys.derive(keyId, { businessId, agentActorId: row.agent_actor_id, delegationId: row.id });
}

/**
 * Every live credential the observing agent holds or was handed in this
 * business: its own delegations (its pickup's and its purpose's), the child
 * delegations they minted for helpers, and its login credentials. Each is
 * derived again from its row's fixed identity under the key it names, as a
 * pickup replay does (`agent-replay.ts`). None for a person's observation;
 * `undefined` when one cannot be derived here, and then no link is kept.
 */
export async function agentCredentials(
  tx: TenantQuery,
  delegationId: string | null,
): Promise<readonly string[] | undefined> {
  if (delegationId === null) return [];
  const rows = await heldRows(tx, delegationId);
  const keys = delegationCredentialKeys();
  if (!keys.ok) return undefined;
  const credentials = rows.map((row) => derivedFrom(keys.keys, tx.businessId, row));
  return credentials.every((credential) => credential !== undefined) ? credentials : undefined;
}
