-- SPDX-License-Identifier: AGPL-3.0-only
--
-- R5 (#1689): single-operator Launch (decision R5-S1-20261018 in
-- docs/current-decisions.md).
--
-- An operator is an active member in a staff role (owner, admin or member),
-- the people `isActiveMember` admits as the configured approver. The business
-- setting `single_operator_mode` is on only while the business has exactly
-- one: its command refuses turning it on otherwise, and the trigger below
-- turns it off in the transaction of any membership write that leaves the
-- business with another number (a second operator, or none), whatever writes
-- the membership. That trigger locks the setting's row for update on every
-- membership write, so a decision that share-locks the row and then counts the
-- operators either waits for that membership and counts it, or is counted
-- before it.
--
-- A decision by the person who requested the correction stands only on a row
-- carrying `single_operator_self_approval`, an approval written while the mode
-- is on. The mark is written with the decision and kept with it.
--
-- Astra's review of a correction is recorded once per writing, bound to the
-- version digest it read, and never changed.

-- The setting, for every business that has the named settings already; a
-- business installed later gets it from `installBusinessSettings`.
insert into public.business_settings
  (business_id, id, key, label, value_type, value, write_mode, owning_operation,
   visibility_class, origin)
select s.business_id, gen_random_uuid(), 'single_operator_mode', 'Single-operator mode',
       'boolean', 'false'::jsonb, 'operation', array['settings.set_single_operator'],
       'internal', 'core'
  from (select distinct business_id from public.business_settings) s
on conflict do nothing;

-- Any number of operators but one turns the mode off, in the same transaction.
create or replace function public.memberships_end_single_operator()
  returns trigger
  language plpgsql
  security invoker
  set search_path = pg_catalog, public
as $$
begin
  perform 1 from public.business_settings
   where business_id = new.business_id and key = 'single_operator_mode'
   for update;
  update public.business_settings
     set value = 'false'::jsonb, revision = revision + 1, updated_at = now()
   where business_id = new.business_id and key = 'single_operator_mode'
     and value = 'true'::jsonb
     and (select count(distinct m.person_id) from public.memberships m
           where m.business_id = new.business_id and m.active and m.ended_at is null
             and m.role_key in ('owner', 'admin', 'member')) <> 1;
  return null;
end;
$$;

revoke all on function public.memberships_end_single_operator() from public;

create trigger memberships_end_single_operator
  after insert or update on public.memberships
  for each row execute function public.memberships_end_single_operator();

-- The mark, and the storage half of the rule.
alter table public.live_corrections
  add column single_operator_self_approval boolean not null default false;

alter table public.live_corrections drop constraint live_corrections_no_self_approval;
alter table public.live_corrections
  add constraint live_corrections_no_self_approval check (
    decided_by_person_id is distinct from requested_by_person_id
    or single_operator_self_approval
  );
alter table public.live_corrections
  add constraint live_corrections_self_approval_marked check (
    not single_operator_self_approval
    or (coalesce(decided_by_person_id = requested_by_person_id, false) and state <> 'rejected')
  );

-- The mark is set only with its decision, only while the mode is on, and kept.
-- A row is never inserted carrying it: a request is stored undecided.
create or replace function public.live_corrections_self_approval_kept()
  returns trigger
  language plpgsql
  security invoker
  set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    if new.single_operator_self_approval then
      raise exception 'live_corrections_self_approval_kept: a request is stored unmarked';
    end if;
    return new;
  end if;
  if new.single_operator_self_approval is distinct from old.single_operator_self_approval then
    if old.decided_at is not null or new.decided_at is null or not new.single_operator_self_approval then
      raise exception 'live_corrections_self_approval_kept: correction % keeps its mark', old.id;
    end if;
    if not exists (select 1 from public.business_settings
                    where business_id = new.business_id and key = 'single_operator_mode'
                      and value = 'true'::jsonb) then
      raise exception 'live_corrections_self_approval_kept: single_operator_mode is off';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.live_corrections_self_approval_kept() from public;

create trigger live_corrections_self_approval_kept
  before insert or update on public.live_corrections
  for each row execute function public.live_corrections_self_approval_kept();

-- Astra's review, recorded by a person from Astra's saved review.
create table public.live_correction_reviews (
  business_id           uuid        not null,
  id                    uuid        not null,
  correction_id         uuid        not null,
  version_digest        text        not null,
  verdict               text        not null,
  review                text        not null,
  recorded_by_actor_id  uuid        not null,
  recorded_by_person_id uuid        not null,
  -- The instant of the insert, not the transaction's start: the latest review counts.
  created_at            timestamptz not null default clock_timestamp(),
  constraint live_correction_reviews_pkey primary key (id),
  constraint live_correction_reviews_tenant_id_key unique (business_id, id),
  constraint live_correction_reviews_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint live_correction_reviews_correction_fkey foreign key (business_id, correction_id)
    references public.live_corrections (business_id, id),
  constraint live_correction_reviews_actor_fkey foreign key (business_id, recorded_by_actor_id)
    references public.actors (business_id, id),
  constraint live_correction_reviews_person_fkey foreign key (business_id, recorded_by_person_id)
    references public.people (business_id, id),
  constraint live_correction_reviews_verdict_known
    check (verdict in ('approve', 'changes_requested')),
  constraint live_correction_reviews_review_present
    check (length(review) between 1 and 20000 and version_digest <> '')
);

create index live_correction_reviews_correction_idx
  on public.live_correction_reviews (business_id, correction_id);

alter table public.live_correction_reviews enable row level security;
alter table public.live_correction_reviews force row level security;

create policy tenancy_live_correction_reviews on public.live_correction_reviews
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_live_correction_reviews on public.live_correction_reviews
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert on public.live_correction_reviews to ops_astro_app;
