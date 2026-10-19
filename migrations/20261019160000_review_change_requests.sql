-- SPDX-License-Identifier: AGPL-3.0-only
--
-- C57 (#2016): a change request filed from a client's pinned review comment.
--
-- A person files one from a client-audience pin (`review.propose_change`, `proposal:write`
-- at the review's holder); it stays proposed until a person holding `proposal:decide`
-- approves or refuses it (`review.decide_change`). Approval writes no task: an approved
-- request with no task is the pending cause a worker will claim under its live lease and
-- make a task of (#2117). One request per pin, and one task per request, so a second filing
-- or a second decision leaves one. The holder is the review's, read from it, never sent.

create table public.review_change_requests (
  business_id           uuid        not null,
  id                    uuid        not null,
  review_id             uuid        not null,
  comment_id            uuid        not null,
  task_id               uuid        not null,
  party_id              uuid,
  request_text          text        not null,
  state                 text        not null default 'proposed',
  proposed_by_actor_id  uuid        not null,
  proposed_by_person_id uuid        not null,
  decided_by_actor_id   uuid,
  decided_by_person_id  uuid,
  decided_at            timestamptz,
  created_task_id       uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint review_change_requests_pkey primary key (id),
  constraint review_change_requests_tenant_id_key unique (business_id, id),
  constraint review_change_requests_one_per_pin unique (business_id, comment_id),
  constraint review_change_requests_one_task unique (business_id, created_task_id),
  constraint review_change_requests_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint review_change_requests_review_fkey foreign key (business_id, review_id)
    references public.reviews (business_id, id),
  constraint review_change_requests_comment_fkey foreign key (business_id, comment_id)
    references public.records (business_id, id),
  constraint review_change_requests_task_fkey foreign key (business_id, task_id)
    references public.records (business_id, id),
  constraint review_change_requests_created_task_fkey foreign key (business_id, created_task_id)
    references public.records (business_id, id),
  constraint review_change_requests_proposer_actor_fkey
    foreign key (business_id, proposed_by_actor_id) references public.actors (business_id, id),
  constraint review_change_requests_proposer_person_fkey
    foreign key (business_id, proposed_by_person_id) references public.people (business_id, id),
  constraint review_change_requests_decider_actor_fkey
    foreign key (business_id, decided_by_actor_id) references public.actors (business_id, id),
  constraint review_change_requests_decider_person_fkey
    foreign key (business_id, decided_by_person_id) references public.people (business_id, id),
  constraint review_change_requests_state_known
    check (state in ('proposed', 'approved', 'refused')),
  -- A proposed request names no decider; a decided one names its actor, person and time, all
  -- three, whatever an UPDATE sends.
  constraint review_change_requests_decided_by_a_person check (
    (state = 'proposed'
       and decided_by_actor_id is null and decided_by_person_id is null and decided_at is null)
    or (state <> 'proposed' and decided_by_actor_id is not null
        and decided_by_person_id is not null and decided_at is not null)
  ),
  constraint review_change_requests_task_only_approved
    check (created_task_id is null or state = 'approved'),
  constraint review_change_requests_text_bounded
    check (char_length(request_text) between 1 and 2000)
);

create index review_change_requests_pending_idx
  on public.review_change_requests (business_id, created_at)
  where state = 'approved' and created_task_id is null;
create index review_change_requests_review_idx
  on public.review_change_requests (business_id, review_id);

alter table public.review_change_requests enable row level security;
alter table public.review_change_requests force row level security;

create policy tenancy_review_change_requests on public.review_change_requests
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_review_change_requests on public.review_change_requests
  as permissive for all using (true) with check (true);

-- Filed once; decided once; its task linked once. Nothing else moves.
grant select, insert on public.review_change_requests to ops_astro_app;
grant update (state, decided_by_actor_id, decided_by_person_id, decided_at, created_task_id,
              updated_at)
  on public.review_change_requests to ops_astro_app;
