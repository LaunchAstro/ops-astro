-- SPDX-License-Identifier: AGPL-3.0-only
--
-- C57 (#2017): the review shepherd's weekly send, the cause of one client comment's email.
--
-- A scheduled occurrence's worker, under its run's live lease, writes a client-audience
-- comment on a review's task, an inbox item for each of the review's own client's people, and
-- this row, in one transaction. The row names the recipients and the digest of the comment and
-- recipients together. The broker sends one of those items only while this send stands: a
-- person approved this exact digest, or a live standing mandate covers the shepherd's class for
-- the client (`core-runtime/src/review-shepherd-authority.ts`). One send per occurrence and
-- review, so a retried occurrence writes nothing twice.

create table public.review_shepherd_sends (
  business_id           uuid        not null,
  id                    uuid        not null,
  occurrence_id         uuid        not null,
  review_id             uuid        not null,
  task_id               uuid        not null,
  party_id              uuid        not null,
  comment_id            uuid        not null,
  recipient_person_ids  uuid[]      not null,
  digest                text        not null,
  worker_actor_id       uuid        not null,
  approved_by_actor_id  uuid,
  approved_by_person_id uuid,
  approved_digest       text,
  approved_at           timestamptz,
  created_at            timestamptz not null default now(),
  constraint review_shepherd_sends_pkey primary key (id),
  constraint review_shepherd_sends_tenant_id_key unique (business_id, id),
  constraint review_shepherd_sends_one_per_occurrence unique (business_id, occurrence_id, review_id),
  constraint review_shepherd_sends_one_per_comment unique (business_id, comment_id),
  constraint review_shepherd_sends_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint review_shepherd_sends_occurrence_fkey foreign key (business_id, occurrence_id)
    references public.activation_occurrences (business_id, id),
  constraint review_shepherd_sends_review_fkey foreign key (business_id, review_id)
    references public.reviews (business_id, id),
  constraint review_shepherd_sends_task_fkey foreign key (business_id, task_id)
    references public.records (business_id, id),
  constraint review_shepherd_sends_comment_fkey foreign key (business_id, comment_id)
    references public.records (business_id, id),
  constraint review_shepherd_sends_worker_fkey foreign key (business_id, worker_actor_id)
    references public.actors (business_id, id),
  constraint review_shepherd_sends_approver_actor_fkey
    foreign key (business_id, approved_by_actor_id) references public.actors (business_id, id),
  constraint review_shepherd_sends_approver_person_fkey
    foreign key (business_id, approved_by_person_id) references public.people (business_id, id),
  constraint review_shepherd_sends_digest_shape check (digest ~ '^[0-9a-f]{64}$'),
  constraint review_shepherd_sends_recipients_named
    check (cardinality(recipient_person_ids) between 1 and 50),
  -- An approval names its actor, person, digest and time, all four, or none of them.
  constraint review_shepherd_sends_approved_by_a_person check (
    (approved_by_actor_id is null and approved_by_person_id is null
       and approved_digest is null and approved_at is null)
    or (approved_by_actor_id is not null and approved_by_person_id is not null
        and approved_digest is not null and approved_at is not null)
  )
);

create index review_shepherd_sends_review_idx
  on public.review_shepherd_sends (business_id, review_id);

alter table public.review_shepherd_sends enable row level security;
alter table public.review_shepherd_sends force row level security;

create policy tenancy_review_shepherd_sends on public.review_shepherd_sends
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_review_shepherd_sends on public.review_shepherd_sends
  as permissive for all using (true) with check (true);

-- Written once; approved once. Nothing else moves.
grant select, insert on public.review_shepherd_sends to ops_astro_app;
grant update (approved_by_actor_id, approved_by_person_id, approved_digest, approved_at)
  on public.review_shepherd_sends to ops_astro_app;
