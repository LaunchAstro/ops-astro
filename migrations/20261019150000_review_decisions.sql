-- SPDX-License-Identifier: AGPL-3.0-only
--
-- C35-X, the version half (#2014, #2076): the one review decision record, bound
-- to the exact revision, and Astra's review of a revision.
--
-- A decision names its revision, the review it belongs to, the digest it
-- covers and the revision's author person, and the foreign keys below hold all
-- four to the revision row, so a decision cannot name another review's
-- revision, an earlier digest, or an author the revision does not carry. The
-- author is the revision's `created_by_person_id`: for an agent's revision,
-- the person it acted for. A decision is never changed; a new revision has no
-- decision until a person makes one. One approval per revision; `response`
-- takes more words later (#2043's request changes) on this same record.
--
-- Self-approval follows R5 (#1689): a decision by the revision's author stands
-- only on a row carrying `single_operator_self_approval`, and the trigger
-- admits that mark only while single-operator mode is on and Astra's latest
-- review of this exact digest approves. Unlike the live correction, every
-- self-approved revision needs its own review. The trigger also refuses a
-- decider whose actor is not that person's own: an agent never decides.

alter table public.review_revisions
  add constraint review_revisions_digest_key unique (business_id, id, review_id, digest),
  add constraint review_revisions_author_key unique (business_id, id, created_by_person_id);

create table public.review_astra_reviews (
  business_id           uuid        not null,
  id                    uuid        not null,
  review_id             uuid        not null,
  revision_id           uuid        not null,
  digest                text        not null,
  verdict               text        not null,
  review                text        not null,
  recorded_by_actor_id  uuid        not null,
  recorded_by_person_id uuid        not null,
  -- The instant of the insert, not the transaction's start: the latest review counts.
  created_at            timestamptz not null default clock_timestamp(),
  constraint review_astra_reviews_pkey primary key (id),
  constraint review_astra_reviews_tenant_id_key unique (business_id, id),
  constraint review_astra_reviews_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint review_astra_reviews_revision_fkey
    foreign key (business_id, revision_id, review_id, digest)
    references public.review_revisions (business_id, id, review_id, digest),
  constraint review_astra_reviews_actor_fkey foreign key (business_id, recorded_by_actor_id)
    references public.actors (business_id, id),
  constraint review_astra_reviews_person_fkey foreign key (business_id, recorded_by_person_id)
    references public.people (business_id, id),
  constraint review_astra_reviews_verdict_known
    check (verdict in ('approve', 'changes_requested')),
  constraint review_astra_reviews_review_present check (length(review) between 1 and 20000)
);

create index review_astra_reviews_revision_idx
  on public.review_astra_reviews (business_id, revision_id);

create table public.review_decisions (
  business_id                   uuid        not null,
  id                            uuid        not null,
  review_id                     uuid        not null,
  revision_id                   uuid        not null,
  digest                        text        not null,
  response                      text        not null,
  author_person_id              uuid        not null,
  decided_by_actor_id           uuid        not null,
  decided_by_person_id          uuid        not null,
  single_operator_self_approval boolean     not null default false,
  created_at                    timestamptz not null default clock_timestamp(),
  constraint review_decisions_pkey primary key (id),
  constraint review_decisions_tenant_id_key unique (business_id, id),
  constraint review_decisions_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint review_decisions_revision_fkey
    foreign key (business_id, revision_id, review_id, digest)
    references public.review_revisions (business_id, id, review_id, digest),
  constraint review_decisions_author_fkey
    foreign key (business_id, revision_id, author_person_id)
    references public.review_revisions (business_id, id, created_by_person_id),
  constraint review_decisions_actor_fkey foreign key (business_id, decided_by_actor_id)
    references public.actors (business_id, id),
  constraint review_decisions_person_fkey foreign key (business_id, decided_by_person_id)
    references public.people (business_id, id),
  constraint review_decisions_response_known check (response in ('approve')),
  constraint review_decisions_no_self_approval check (
    decided_by_person_id <> author_person_id or single_operator_self_approval
  ),
  constraint review_decisions_self_approval_marked check (
    not single_operator_self_approval or decided_by_person_id = author_person_id
  )
);

create unique index review_decisions_one_approval
  on public.review_decisions (business_id, revision_id) where response = 'approve';
create index review_decisions_review_idx on public.review_decisions (business_id, review_id);

-- The decider is a person acting as themselves, and the mark rests on the mode and on Astra.
create or replace function public.review_decisions_decider_and_mark()
  returns trigger
  language plpgsql
  security invoker
  set search_path = pg_catalog, public
as $$
begin
  -- A row outside the caller's business is the restrictive policy's to refuse, not this one's.
  if new.business_id is distinct from (select public.app_business_id()) then
    return new;
  end if;
  if not exists (select 1 from public.actors a
                  where a.business_id = new.business_id and a.id = new.decided_by_actor_id
                    and a.kind = 'person' and a.person_id = new.decided_by_person_id) then
    raise exception 'review_decisions_decider_and_mark: a person decides as themselves'
      using errcode = 'check_violation';
  end if;
  if not new.single_operator_self_approval then
    return new;
  end if;
  if not exists (select 1 from public.business_settings
                  where business_id = new.business_id and key = 'single_operator_mode'
                    and value = 'true'::jsonb) then
    raise exception 'review_decisions_decider_and_mark: single_operator_mode is off'
      using errcode = 'check_violation';
  end if;
  if coalesce((select r.verdict from public.review_astra_reviews r
                where r.business_id = new.business_id and r.revision_id = new.revision_id
                  and r.digest = new.digest
                order by r.created_at desc, r.id desc
                limit 1), '') <> 'approve' then
    raise exception 'review_decisions_decider_and_mark: no approving Astra review of this digest'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.review_decisions_decider_and_mark() from public;

create trigger review_decisions_decider_and_mark
  before insert on public.review_decisions
  for each row execute function public.review_decisions_decider_and_mark();

alter table public.review_astra_reviews enable row level security;
alter table public.review_astra_reviews force row level security;
alter table public.review_decisions enable row level security;
alter table public.review_decisions force row level security;

create policy tenancy_review_astra_reviews on public.review_astra_reviews
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_review_astra_reviews on public.review_astra_reviews
  as permissive for all using (true) with check (true);

create policy tenancy_review_decisions on public.review_decisions
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_review_decisions on public.review_decisions
  as permissive for all using (true) with check (true);

-- Neither is ever changed or removed.
grant select, insert on public.review_astra_reviews to ops_astro_app;
grant select, insert on public.review_decisions to ops_astro_app;
