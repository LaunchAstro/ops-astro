-- SPDX-License-Identifier: AGPL-3.0-only
--
-- #2351: a request to delete a task, and a person's answer to it.
--
-- An agent never deletes a task. It asks, with a reason, and a person answers
-- in Ops Astro: `confirmed` (the task is deleted as `task.delete` deletes it),
-- `kept`, or `lapsed`, written when a later request finds it seven days past
-- its making unanswered. One open request per task. The requester is the actor
-- that asked (an agent's own actor, or a person's) for the person it acts for.
--
-- The request names its task with a cascading key: a purge that removes the
-- task removes what was asked of it, while the audit events of the ask and the
-- answer stay in the chain. Additive; `drop table public.task_delete_requests`
-- reverses it, and nothing else names the table.

create table public.task_delete_requests (
  business_id             uuid        not null,
  id                      uuid        not null,
  task_id                 uuid        not null,
  reason                  text        not null,
  requested_by_actor_id   uuid        not null,
  requested_for_person_id uuid        not null,
  requested_at            timestamptz not null,
  expires_at              timestamptz not null,
  answer                  text,
  answered_by_actor_id    uuid,
  answered_at             timestamptz,
  constraint task_delete_requests_pkey primary key (id),
  constraint task_delete_requests_tenant_id_key unique (business_id, id),
  constraint task_delete_requests_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint task_delete_requests_task_fkey foreign key (business_id, task_id)
    references public.records (business_id, id) on delete cascade,
  constraint task_delete_requests_requested_by_fkey foreign key (business_id, requested_by_actor_id)
    references public.actors (business_id, id),
  constraint task_delete_requests_requested_for_fkey
    foreign key (business_id, requested_for_person_id)
    references public.people (business_id, id),
  constraint task_delete_requests_answered_by_fkey foreign key (business_id, answered_by_actor_id)
    references public.actors (business_id, id),
  constraint task_delete_requests_reason_length check (char_length(reason) between 1 and 500),
  constraint task_delete_requests_expiry_after check (expires_at > requested_at),
  constraint task_delete_requests_answer_known
    check (answer in ('confirmed', 'kept', 'lapsed')),
  constraint task_delete_requests_answered_whole
    check ((answer is null) = (answered_at is null)
       and (answer is not null and answer <> 'lapsed') = (answered_by_actor_id is not null))
);

create unique index task_delete_requests_one_open
  on public.task_delete_requests (business_id, task_id) where answer is null;

alter table public.task_delete_requests enable row level security;
alter table public.task_delete_requests force row level security;

create policy tenancy_task_delete_requests on public.task_delete_requests
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_task_delete_requests on public.task_delete_requests
  as permissive for all using (true) with check (true);

-- A request is written once and answered once, by column; it is never removed but by its task.
grant select, insert on public.task_delete_requests to ops_astro_app;
grant update (answer, answered_by_actor_id, answered_at) on public.task_delete_requests
  to ops_astro_app;
