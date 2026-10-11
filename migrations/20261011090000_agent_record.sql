-- SPDX-License-Identifier: AGPL-3.0-only
--
-- An agent of the business has a name and a person who owns it, and a task
-- handed to an agent names the agent, not a delegation.
--
-- Until now a task's `agent` field (0082) held a delegation the assigner
-- held for that one task, and revoking or expiring the delegation took the
-- task back. A delegation is the authority for one run; an assignment is who
-- holds the work. So the field now holds the agent actor (0002), and the
-- assignment stays until a person changes it. `task.assign` asks that the
-- agent is this business's and that the assigner owns it or holds
-- `agent:assign` (`packages/core-records/src/identity/agents.ts`); no
-- delegation is needed to assign one.
--
-- No function is added. The columns sit on `actors`, whose row security is
-- already enabled, forced and keyed on the business.

alter table public.actors
  add column display_name text,
  add column owner_person_id uuid,
  add constraint actors_owner_fkey foreign key (business_id, owner_person_id)
    references public.people (business_id, id),
  -- A person or a worker has neither: its name is the person's, and nobody
  -- owns a worker.
  add constraint actors_name_and_owner_are_an_agents check (
    kind = 'agent' or (display_name is null and owner_person_id is null)
  ),
  add constraint actors_display_name_shape check (
    display_name is null
    or (display_name = btrim(display_name) and length(display_name) between 1 and 60)
  );

create index actors_owner_idx
  on public.actors (business_id, owner_person_id)
  where owner_person_id is not null;

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
