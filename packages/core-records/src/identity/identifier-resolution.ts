// SPDX-License-Identifier: AGPL-3.0-only
//
// Identity resolution produces candidates, never a merge.
//
// Three arms, and the middle one is the reason the module exists (minimum
// contract, section 1.4). An identifier matching exactly one person attaches
// as an observation on that person. An identifier matching more than one is
// presented as unresolved and attaches to **none**. An identifier matching
// nobody creates a person, because a new person is cheap and a wrong merge is
// not.
//
// A merge is the other half of the same rule. Two people the business has
// already decided are one person are one person here too: matches are mapped
// through `person_merges` to their surviving person before they are counted,
// so a decided merge resolves rather than presenting as ambiguous, and a
// reversed one goes back to being two. That is what keeps the merge record
// from being a row nothing reads.
//
// What this module does not do: it does not write a merge candidate, because
// the first slice has no table for one, and it does not record who observed
// what — the audit event per attempt is T1f's, and it will wrap these calls
// rather than replace them.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';

export type IdentifierKind = 'email' | 'phone';

export interface Observation {
  readonly kind: IdentifierKind;
  /** As the source presented it. Normalising is this module's job, not the caller's. */
  readonly value: string;
  readonly sourceSystem: string;
  readonly sourceId?: string;
  readonly confidence?: number;
  /** Read only when nobody matches, because only then is a person created. */
  readonly displayName?: string;
}

export type IdentifierResolution =
  | {
      readonly outcome: 'attached';
      readonly personId: string;
      readonly identifierId: string;
      readonly person: 'existing' | 'new';
    }
  | {
      readonly outcome: 'unresolved';
      /** The surviving people the identifier reached. A human decides between them. */
      readonly candidatePersonIds: readonly string[];
    };

/**
 * The form matching reads. One login written with capitals and a trailing
 * space, and the same login written in lower case, are one address, and a
 * phone number's punctuation is the source's habit rather than a fact about
 * the person.
 */
export function normaliseIdentifier(kind: IdentifierKind, value: string): string {
  const trimmed = value.trim();
  if (kind === 'email') return trimmed.toLowerCase();
  const digits = trimmed.replaceAll(/\D/gu, '');
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

// The chain walk. A person absorbed into a person who was later absorbed
// again resolves to the last survivor, so a merge decided months apart still
// reads as one person.
//
// The CYCLE clause is not decoration. `person_merges` stops one person being
// absorbed twice at once, but nothing stops A being absorbed into B and B into
// A, and a recursive query over that pair does not terminate. With CYCLE it
// stops and marks the row that came back round, and that row's person is where
// the cycle starts. A chain that went round resolves there, not to the deepest
// unmarked row, which is just wherever the walk stood when it noticed: so a
// person inside a cycle is themselves, and a cycle degrades to "no merge"
// rather than to a hung request or to one member silently absorbing another.
//
// A person absorbed into a cycle from outside stops at the member they were
// absorbed into. That merge is not part of the cycle and nobody has undone it,
// so it still holds; only the merges that go round are read as undecided.
//
// A person is absorbed once at a time, so each chain is a line and has at most
// one marked row.
const SURVIVORS = `
  with recursive chain(person_id, current_id, depth) as (
    select p.id, p.id, 0
      from unnest($1::uuid[]) as p(id)
    union all
    select c.person_id, m.surviving_person_id, c.depth + 1
      from chain c
      join public.person_merges m
        on m.absorbed_person_id = c.current_id and m.reversed_at is null
  ) cycle current_id set is_cycle using path
  select distinct on (person_id) current_id as survivor_id
    from chain
   order by person_id, is_cycle desc, depth desc`;

/** The surviving people the given people resolve to, deduplicated and ordered. */
export async function survivingPersonIds(
  tx: TenantQuery,
  personIds: readonly string[],
): Promise<readonly string[]> {
  if (personIds.length === 0) return [];
  const rows = await tx.query<{ readonly survivor_id: string }>(SURVIVORS, [personIds]);
  return [...new Set(rows.map((row) => row.survivor_id))].toSorted();
}

const ATTACH = `
  insert into public.person_identifiers
    (business_id, id, person_id, kind, value, observed_value, source_system, source_id, confidence)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  on conflict (business_id, person_id, kind, value) do update
     set last_observed_at = now(),
         observed_value   = excluded.observed_value,
         source_system    = excluded.source_system,
         source_id        = excluded.source_id,
         confidence       = greatest(person_identifiers.confidence, excluded.confidence)
  returning id`;

async function attach(
  tx: TenantQuery,
  personId: string,
  observation: Observation,
  value: string,
): Promise<string> {
  const rows = await tx.query<{ readonly id: string }>(ATTACH, [
    tx.businessId,
    randomUUID(),
    personId,
    observation.kind,
    value,
    observation.value.trim(),
    observation.sourceSystem,
    observation.sourceId ?? null,
    observation.confidence ?? 1,
  ]);
  const attached = rows[0];
  if (attached === undefined) throw new Error('resolveIdentifier: the observation did not attach');
  return attached.id;
}

async function createPerson(tx: TenantQuery, displayName: string): Promise<string> {
  const rows = await tx.query<{ readonly id: string }>(
    `insert into public.people (business_id, id, display_name) values ($1, $2, $3) returning id`,
    [tx.businessId, randomUUID(), displayName],
  );
  const created = rows[0];
  if (created === undefined) throw new Error('resolveIdentifier: the person was not created');
  return created.id;
}

/**
 * Attach an observed identifier to the one person it means, or to nobody.
 *
 * The unresolved arm writes nothing at all — not the identifier, not a person,
 * not a candidate. Anything written there is the arbitration this rule exists
 * to prevent, arriving through the back door.
 */
export async function resolveIdentifier(
  tx: TenantQuery,
  observation: Observation,
): Promise<IdentifierResolution> {
  const value = normaliseIdentifier(observation.kind, observation.value);
  const matched = await tx.query<{ readonly person_id: string }>(
    `select distinct person_id from public.person_identifiers where kind = $1 and value = $2`,
    [observation.kind, value],
  );
  const survivors = await survivingPersonIds(
    tx,
    matched.map((row) => row.person_id),
  );

  if (survivors.length > 1) return { outcome: 'unresolved', candidatePersonIds: survivors };

  const existing = survivors[0];
  const personId =
    existing ?? (await createPerson(tx, observation.displayName ?? observation.value.trim()));
  const identifierId = await attach(tx, personId, observation, value);
  return {
    outcome: 'attached',
    personId,
    identifierId,
    person: existing === undefined ? 'new' : 'existing',
  };
}
