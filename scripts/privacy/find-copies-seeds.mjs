// SPDX-License-Identifier: AGPL-3.0-only
//
// The copy finder's seeds (find-copies.mjs): the ids that stand for the
// people a request names, and their stored names. Moved whole out of the
// finder for the 300-line limit.

/** The longest value, in bytes, the parser reads whole: under its 16,383 word positions and its 1 MiB vector. */
export const PARSED = 16_000;

/** The longest name or text, in bytes, read as a phrase: it nests a level a word, and too deep a phrase exhausts the database's stack. */
export const PHRASED = 1_000;

/**
 * Whether the parser reads `value` whole against `query`: the query is a
 * phrase, the value at most PARSED bytes, and none of the query's `lexemes`
 * past the 256 positions the parser keeps of a word in it, where a phrase
 * after a word's 256th use would be lost.
 */
const readable = (value, query, lexemes) => `case
      when ${query} is not null and octet_length(${value}) <= ${PARSED}
      then not exists (select from unnest(to_tsvector('simple', ${value})) u
                        where u.lexeme = any(${lexemes}) and cardinality(u.positions) >= 256)
      else false end`;

/**
 * Whether `value` holds the words of `query` in order: both go through the
 * database's own text-search parser, so the words are its words and its
 * letter folding ("Anna" is in "Anna-Maria Lee", never in "Joanna"). A value
 * the parser cannot read whole (`readable`) would overflow it or lose word
 * order, and a null query is a name too long to be a phrase, so then `value` holds them when it holds
 * each of `lexemes`, the query's words, anywhere, even inside other words: a
 * looser match, listing more for the owner to judge and never less.
 */
export const wholeWords = (value, query, lexemes) => `(${value} is not null
      and cardinality(${lexemes}) > 0 and case
      when ${readable(value, query, lexemes)} then to_tsvector('simple', ${value}) @@ ${query}
      else not exists (select from unnest(${lexemes}) w where strpos(lower(${value}), w) = 0) end)`;

/** The text ($2) as a phrase (null when too long to be one) and as its words. */
const TEXT_QUERY = `case when octet_length($2::text) <= ${PHRASED} then phraseto_tsquery('simple', $2) end`;
const TEXT_LEXEMES = `tsvector_to_array(to_tsvector('simple', $2))`;
/** Whether `value` holds the text ($2) as whole words, in order, or loosely. */
const NAMES = (value) => wholeWords(value, TEXT_QUERY, TEXT_LEXEMES);

/** Whether `value` holds the text ($2) as whole words read by the parser, not loosely. */
const EXACTLY = (value) => `case when ${readable(value, TEXT_QUERY, TEXT_LEXEMES)}
      then ${NAMES(value)} else false end`;

/** How a person is found by the text: as whole words, or only loosely. */
const NAMED = (...values) => `case when ${values.map((value) => EXACTLY(value)).join(' or ')}
      then 'named by the text' else 'named loosely by the text, its words anywhere' end`;

/**
 * The seeds ($2 the text or null, $3 the given ids, in business $1): each id
 * standing for a person the request names, with that person. A person is
 * named by their name or an identifier not rejected, and is one person with
 * anyone a merge not reversed joined them to (their cluster; the given ids
 * are one cluster); their actors, the logins they still hold and each
 * delegation acting for them stand for them, and so does the agent actor of
 * each credential they issued or delegation acting for them, with the logins
 * it still holds. An agent that a credential or delegation of anyone outside
 * the cluster it was reached from names too (one agent can act for several
 * people), whether reached so or given by --id, is shared, and so is a login
 * given by --id that is or was linked to an agent not standing for the given
 * ids' cluster, unless that cluster's own agent or person holds it now: a
 * shared id stands for no one and comes back marked `shared`, with the person
 * it was found for. None of these leads to another person, so the set is
 * closed. Each seed says how its person was found.
 */
export const SEEDS = `with recursive named(id, root, how) as (
    select p.id, p.id, ${NAMED('p.display_name')} from public.people p
     where p.business_id = $1 and $2::text is not null and ${NAMES('p.display_name')}
    union
    select i.person_id, i.person_id, ${NAMED('i.value', 'i.observed_value')}
      from public.person_identifiers i
     where i.business_id = $1 and $2::text is not null and i.review_state <> 'rejected'
       and (${NAMES('i.value')} or ${NAMES('i.observed_value')})
    union
    select given, '00000000-0000-0000-0000-000000000000'::uuid, 'given by --id'
      from unnest($3::uuid[]) given),
  joined(id, root, how) as (
    select id, root, how from named
    union
    select case when m.surviving_person_id = j.id
                then m.absorbed_person_id else m.surviving_person_id end,
           j.root, 'merged with ' || j.id::text
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
  agents(id, person, root) as (
    select c.agent_actor_id, j.id, j.root from public.agent_credentials c
      join joined j on j.id = c.issued_by_person_id
     where c.business_id = $1
    union
    select d.agent_actor_id, j.id, j.root from public.delegations d
      join joined j on j.id = d.delegate_person_id
     where d.business_id = $1
    union
    select a.id, a.id, j.root from public.actors a join joined j on j.id = a.id
     where a.business_id = $1 and a.kind = 'agent'),
  shared_agents(id) as (
    select g.id from agents g
     where exists (select from public.agent_credentials c
                    where c.business_id = $1 and c.agent_actor_id = g.id
                      and c.issued_by_person_id not in (select k.id from joined k where k.root = g.root))
        or exists (select from public.delegations d
                    where d.business_id = $1 and d.agent_actor_id = g.id
                      and d.delegate_person_id not in (select k.id from joined k where k.root = g.root))),
  given_agents(id) as (
    select id from agents where root = '00000000-0000-0000-0000-000000000000'::uuid
    except
    select id from shared_agents),
  shared(id) as (
    select id from shared_agents
    union
    select l.login_id from public.actor_logins l
     where l.business_id = $1 and l.login_id in (select id from unnest($3::uuid[]) id)
       and exists (select from public.actors a
                    where a.business_id = $1 and a.id = l.actor_id and a.kind = 'agent'
                      and a.id not in (select id from given_agents))
       and not exists (select from public.actor_logins h
                        where h.business_id = $1 and h.login_id = l.login_id and h.active
                          and h.actor_id in (select id from given_agents))
       and not exists (select from public.person_logins h
                        where h.business_id = $1 and h.login_id = l.login_id and h.active
                          and h.person_id in (select k.id from joined k
                                               where k.root = '00000000-0000-0000-0000-000000000000'::uuid))),
  acting(id, person, how) as (
    select a.id, p.id, p.how from public.actors a join persons p on p.id = a.person_id
     where a.business_id = $1
    union
    select g.id, g.person, p.how from agents g join persons p on p.id = g.person
     where g.id not in (select id from shared))
  select p.id::text as id, p.id::text as person, p.how, p.id in (select id from shared) as shared
    from persons p
  union
  select a.id::text, a.person::text, a.how, false from acting a
  union
  select g.id::text, g.person::text, p.how, true from agents g join persons p on p.id = g.person
   where g.id in (select id from shared) and g.id <> g.person
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

/**
 * The stored names of the seeds' people ($2) in business $1, each with its
 * words as lexemes (null for a name too long to parse) and as a query (null
 * for a name too long to be a phrase, which is matched loosely).
 */
export const STORED_NAMES = `select p.id::text as person, p.display_name as name,
      case when octet_length(p.display_name) <= ${PHRASED}
           then phraseto_tsquery('simple', p.display_name)::text end as words,
      case when octet_length(p.display_name) <= ${PARSED}
           then tsvector_to_array(to_tsvector('simple', p.display_name)) end as lexemes
    from public.people p
   where p.business_id = $1 and p.id = any($2::uuid[])`;
