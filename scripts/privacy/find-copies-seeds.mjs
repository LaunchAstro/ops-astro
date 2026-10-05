// SPDX-License-Identifier: AGPL-3.0-only
//
// The copy finder's seeds (find-copies.mjs): the ids that stand for the
// people a request names, and their stored names. Moved whole out of the
// finder for the 300-line limit.

/**
 * Whether `value` holds the text ($2) as whole words, in order: both go
 * through the database's own text-search parser, so the words are its words
 * and its letter folding ("Anna" is in "Anna-Maria Lee", never in "Joanna").
 */
const NAMES = (value) => `to_tsvector('simple', ${value}) @@ phraseto_tsquery('simple', $2)`;

/**
 * The seeds ($2 the text or null, $3 the given ids, in business $1): each id
 * standing for a person the request names, with that person. A person is
 * named by their name or an identifier not rejected, and is one person with
 * anyone a merge not reversed joined them to; their actors, the logins they
 * still hold and each delegation acting for them stand for them, and so does
 * the agent actor of each credential they issued or delegation acting for
 * them, with the logins it still holds. An agent that a credential or
 * delegation of anyone else names too (one agent can act for several people),
 * whether found so or given by --id, is shared: it stands for no one and comes
 * back marked `shared`, with the person it was found for. None of these leads
 * to another person, so the set is closed. Each seed says how its person was
 * found.
 */
export const SEEDS = `with recursive named(id, how) as (
    select p.id, 'named by the text' from public.people p
     where p.business_id = $1 and $2::text is not null and ${NAMES('p.display_name')}
    union
    select i.person_id, 'named by the text' from public.person_identifiers i
     where i.business_id = $1 and $2::text is not null and i.review_state <> 'rejected'
       and (${NAMES('i.value')} or ${NAMES('i.observed_value')})
    union
    select unnest($3::uuid[]), 'given by --id'),
  joined(id, how) as (
    select id, how from named
    union
    select case when m.surviving_person_id = j.id
                then m.absorbed_person_id else m.surviving_person_id end,
           'merged with ' || j.id::text
      from joined j
      join public.person_merges m
        on m.business_id = $1 and m.reversed_at is null
       and j.id in (m.surviving_person_id, m.absorbed_person_id)),
  persons as (
    select id, string_agg(how, '; ' order by
             case how when 'named by the text' then 0 when 'given by --id' then 1 else 2 end, how)
             as how
      from (select distinct id, how from joined) found
     group by id),
  agents(id, person, how) as (
    select c.agent_actor_id, p.id, p.how from public.agent_credentials c
      join persons p on p.id = c.issued_by_person_id
     where c.business_id = $1
    union
    select d.agent_actor_id, p.id, p.how from public.delegations d
      join persons p on p.id = d.delegate_person_id
     where d.business_id = $1),
  shared(id) as (
    select a.id from public.actors a
     where a.business_id = $1 and a.kind = 'agent'
       and (a.id in (select id from agents) or a.id in (select id from persons))
       and (exists (select from public.agent_credentials c
                     where c.business_id = $1 and c.agent_actor_id = a.id
                       and c.issued_by_person_id not in (select id from persons))
         or exists (select from public.delegations d
                     where d.business_id = $1 and d.agent_actor_id = a.id
                       and d.delegate_person_id not in (select id from persons)))),
  acting(id, person, how) as (
    select a.id, p.id, p.how from public.actors a join persons p on p.id = a.person_id
     where a.business_id = $1
    union
    select g.id, g.person, g.how from agents g where g.id not in (select id from shared))
  select p.id::text as id, p.id::text as person, p.how, p.id in (select id from shared) as shared
    from persons p
  union
  select a.id::text, a.person::text, a.how, false from acting a
  union
  select g.id::text, g.person::text, g.how, true from agents g where g.id in (select id from shared)
  union
  select d.id::text, p.id::text, p.how, false from public.delegations d
    join persons p on p.id = d.delegate_person_id
   where d.business_id = $1
  union
  select l.login_id::text, p.id::text, p.how, false from public.person_logins l
    join persons p on p.id = l.person_id
   where l.business_id = $1 and l.active
  union
  select l.login_id::text, a.person::text, a.how, false from public.actor_logins l
    join acting a on a.id = l.actor_id
   where l.business_id = $1 and l.active
  order by 2, 1`;

/** The stored names of the seeds' people ($2) in business $1, each with its words as a query. */
export const STORED_NAMES = `select p.display_name as name, phraseto_tsquery('simple', p.display_name)::text as words
    from public.people p
   where p.business_id = $1 and p.id = any($2::uuid[])`;
