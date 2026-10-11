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
-- `agent:assign` (`packages/core-records/src/authority/agents.ts`); no
-- delegation is needed to assign one.
--
-- No function is added. The columns sit on `actors`, whose row security is
-- already enabled, forced and keyed on the business. They ask nothing past
-- 0002, so an upgrade test that seeds an older install with today's runtime
-- (whose four-eyes read joins `owner_person_id`) applies this file with its
-- seed. The owners and the tasks move in 20261011115839.

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
