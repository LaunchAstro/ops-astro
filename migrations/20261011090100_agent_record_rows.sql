-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The rows already here, for the agent record (20261011090000): an owner for
-- each agent where it is plain, and every task held by a delegation moved to
-- that delegation's agent. Kept apart from the columns, which an older install
-- seeded with today's runtime takes first; this reads agent credentials
-- (0054) and the delegations a task held (0082).

-- ---------------------------------------------------------------------------
-- An owner for the agents already here.
-- ---------------------------------------------------------------------------

-- An agent credential's issuer owns its agent: a credential has one agent and
-- the agent was made for it (0054).
update public.actors a
   set owner_person_id = c.issued_by_person_id
  from public.agent_credentials c
 where a.business_id = c.business_id and a.id = c.agent_actor_id
   and a.kind = 'agent' and a.owner_person_id is null;

-- Otherwise the one person whose own delegations of the agent hold tasks:
-- under 0082's rule only that person could have assigned it. An agent whose
-- held delegations are several people's (one worker's agent, say) is nobody's
-- to claim, and neither is an agent no task holds: each keeps no owner, and
-- only a holder of `agent:assign` directs it.
update public.actors a
   set owner_person_id = held.person
  from (
    select d.business_id, d.agent_actor_id, min(d.delegate_person_id::text)::uuid as person
      from public.delegations d
      join public.records r on r.business_id = d.business_id and r.data ->> 'agent' = d.id::text
      join public.record_types t
        on t.business_id = r.business_id and t.id = r.record_type_id and t.key = 'task'
     group by d.business_id, d.agent_actor_id
    having count(distinct d.delegate_person_id) = 1
  ) held
 where a.business_id = held.business_id and a.id = held.agent_actor_id
   and a.kind = 'agent' and a.owner_person_id is null;

-- ---------------------------------------------------------------------------
-- Every task held by a delegation now names that delegation's agent.
-- ---------------------------------------------------------------------------

-- The value stays the uuid text 0082 declared. The records trigger moves each
-- task's revision on, so a client holding the old revision is told to read
-- the task again rather than write over this.
update public.records r
   set data = jsonb_set(r.data, '{agent}', to_jsonb(d.agent_actor_id::text))
  from public.delegations d, public.record_types t
 where d.business_id = r.business_id and r.data ->> 'agent' = d.id::text
   and t.business_id = r.business_id and t.id = r.record_type_id and t.key = 'task';
