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
//
// A link a human rejected is not evidence. It stays on the person as the record
// of that decision, but matching reads only observed and confirmed links, so a
// rejected one neither attaches a new observation nor makes it ambiguous. Nor
// is the person who rejected it a candidate through another link (an absorbed
// person's, say): attaching there would write over the rejection.
//
// Match and create are one step. Two first observations of one identifier
// would otherwise both find nobody and both create a person (the unique index
// includes the person, so nothing conflicts), and every later observation would
// then be unresolved between the two. A lookup that finds nobody takes the
// business's first-sighting lock, held to commit, and looks again; under read
// committed the second lookup sees what the lock's last holder committed. One
// lock per business rather than per identifier, so two transactions first
// sighting two identifiers in opposite order queue rather than deadlock, and a
// lookup that finds someone takes no lock. Calls sharing one transaction share
// its lock as well, so the create also refuses once a live link has appeared
// since its lookup, and the call resolves again.

import { randomUUID } from 'node:crypto';
import { advisoryLock, type TenantQuery } from '../tenancy/database.ts';

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
     set last_observed_at = greatest(person_identifiers.last_observed_at, now()),
         observed_value   = excluded.observed_value,
         source_system    = excluded.source_system,
         source_id        = excluded.source_id,
         confidence       = greatest(person_identifiers.confidence, excluded.confidence)
   where person_identifiers.review_state <> 'rejected'
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

// The person and their link in one statement, and neither unless no live link
// has appeared since the lookup that read `seen`.
const CREATE = `
  with person as (
    insert into public.people (business_id, id, display_name)
    select $1, $2, $3
     where not exists (
       select 1 from public.person_identifiers
        where kind = $4 and value = $5 and review_state <> 'rejected'
          and person_id <> all($6::uuid[]))
    returning id)
  insert into public.person_identifiers
    (business_id, id, person_id, kind, value, observed_value, source_system, source_id, confidence)
  select $1, $7, person.id, $4, $5, $8, $9, $10, $11 from person
  returning id, person_id`;

async function createAttached(
  tx: TenantQuery,
  observation: Observation,
  value: string,
  seen: readonly string[],
): Promise<IdentifierResolution | undefined> {
  const rows = await tx.query<{ readonly id: string; readonly person_id: string }>(CREATE, [
    tx.businessId,
    randomUUID(),
    observation.displayName ?? observation.value.trim(),
    observation.kind,
    value,
    seen,
    randomUUID(),
    observation.value.trim(),
    observation.sourceSystem,
    observation.sourceId ?? null,
    observation.confidence ?? 1,
  ]);
  const created = rows[0];
  if (created === undefined) return undefined;
  return {
    outcome: 'attached',
    personId: created.person_id,
    identifierId: created.id,
    person: 'new',
  };
}

interface Match {
  /** The surviving people the live links reach, less any who rejected the identifier. */
  readonly survivors: readonly string[];
  /** The people holding a live link, before survivors are taken. */
  readonly live: readonly string[];
}

async function match(tx: TenantQuery, kind: IdentifierKind, value: string): Promise<Match> {
  const links = await tx.query<{ readonly person_id: string; readonly rejected: boolean }>(
    `select person_id, review_state = 'rejected' as rejected from public.person_identifiers
      where kind = $1 and value = $2`,
    [kind, value],
  );
  const rejecters = new Set(links.filter((link) => link.rejected).map((link) => link.person_id));
  const live = links.filter((link) => !link.rejected).map((link) => link.person_id);
  const survivors = await survivingPersonIds(tx, live);
  return { survivors: survivors.filter((id) => !rejecters.has(id)), live };
}

async function matchLocked(tx: TenantQuery, kind: IdentifierKind, value: string): Promise<Match> {
  await advisoryLock(tx, `person-identifier:${tx.businessId.toLowerCase()}`);
  return await match(tx, kind, value);
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
  const unlocked = await match(tx, observation.kind, value);
  const found =
    unlocked.survivors.length > 0 ? unlocked : await matchLocked(tx, observation.kind, value);

  if (found.survivors.length > 1) {
    return { outcome: 'unresolved', candidatePersonIds: found.survivors };
  }
  const existing = found.survivors[0];
  if (existing !== undefined) {
    const identifierId = await attach(tx, existing, observation, value);
    return { outcome: 'attached', personId: existing, identifierId, person: 'existing' };
  }
  return (
    (await createAttached(tx, observation, value, found.live)) ??
    (await resolveIdentifier(tx, observation))
  );
}
