-- SPDX-License-Identifier: AGPL-3.0-only
--
-- C35 (#2018, D17-14, TR-P-1): the closed other-company adversarial reviews of
-- the capture pool. Until three distinct reviews of the pool the fence runs now
-- are recorded closed, the site runner refuses every page outside the agency's
-- own (`capture/fence.ts`); it reads its pool from these rows.
--
-- The reviews are the installation's, not a business's, so they live in `ops`
-- beside the first-client gate. One row per review, named by a stable
-- lower-case identity, carrying the pool version it reviewed, its https
-- evidence link and the reviewer's company, and who recorded it: a person of
-- the business that operated the installation then, by the operation the audit
-- chain names. A review is recorded closed or not at all.
--
-- The application writes through `operations.record_capture_pool_review` only
-- (`pool-review-write.ts`): insert alone, so a recorded review is never changed
-- or removed, and it reads back the identity and the version alone, which is
-- all the runner needs. The evidence and the reviewer stay with the owner.

create table ops.capture_pool_reviews (
  review                 text        not null,
  pool_version           text        not null,
  status                 text        not null default 'closed',
  evidence               text        not null,
  company                text        not null,
  operator_business_id   uuid        not null,
  recorded_by_person_id  uuid        not null,
  recorded_by_actor_id   uuid        not null,
  operation_id           uuid        not null,
  recorded_at            timestamptz not null default now(),
  constraint capture_pool_reviews_pkey primary key (review),
  constraint capture_pool_reviews_person_fkey
    foreign key (operator_business_id, recorded_by_person_id)
    references public.people (business_id, id),
  constraint capture_pool_reviews_actor_fkey
    foreign key (operator_business_id, recorded_by_actor_id)
    references public.actors (business_id, id),
  constraint capture_pool_reviews_review_named check (review ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  constraint capture_pool_reviews_version_named
    check (pool_version ~ '^[a-z0-9][a-z0-9.-]{0,31}$'),
  constraint capture_pool_reviews_closed check (status = 'closed'),
  constraint capture_pool_reviews_evidence_link check (
    evidence ~ '^https://[^[:space:]@#]+$' and length(evidence) <= 2000
  ),
  constraint capture_pool_reviews_company_named check (
    company = btrim(company) and length(company) between 1 and 200
      and company !~ '[[:cntrl:]]'
  )
);

grant insert on ops.capture_pool_reviews to ops_astro_app;
grant select (review, pool_version) on ops.capture_pool_reviews to ops_astro_app;

-- Row security, so a business other than the installation's operator never
-- adds a review past the command: a row is the operator's alone, recorded
-- from the operator's own session. Every business reads the identity and the
-- version alike, as the runner does wherever it captures.
alter table ops.capture_pool_reviews enable row level security;
alter table ops.capture_pool_reviews force row level security;
create policy read_capture_pool_reviews on ops.capture_pool_reviews
  as permissive for select using (true);
create policy record_capture_pool_reviews on ops.capture_pool_reviews
  as permissive for insert
  with check (
    operator_business_id = (select public.app_business_id())
      and operator_business_id = (select i.operator_business_id from ops.installation i)
  );
