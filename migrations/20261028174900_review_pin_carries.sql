-- SPDX-License-Identifier: AGPL-3.0-only
--
-- C35-X (#2075, #2014 slice A): a review's pins carried to its new revision.
--
-- A carry is the worker's write under its lease (`review.carry_pins`), once both widths of
-- the new revision have landed: one row per pin and destination revision, from the revision
-- whose spot it was found from. A pin found again carries the anchor that finds it on the new
-- revision; a lost one carries none, so no coordinate is ever guessed. The comment and its
-- first anchor are never changed: a carry is history beside them. Rows are written once and
-- never changed or removed.

-- A carry names its revisions with their review, so both are of the review it is on.
alter table public.review_revisions
  add constraint review_revisions_review_id_key unique (business_id, review_id, id);

create table public.review_pin_carries (
  business_id          uuid        not null,
  id                   uuid        not null,
  review_id            uuid        not null,
  comment_id           uuid        not null,
  from_revision_id     uuid        not null,
  to_revision_id       uuid        not null,
  state                text        not null,
  anchor               jsonb,
  lease_id             uuid        not null,
  fence                bigint      not null,
  operation_id         text        not null,
  carried_by_actor_id  uuid        not null,
  created_at           timestamptz not null default now(),
  constraint review_pin_carries_pkey primary key (id),
  constraint review_pin_carries_tenant_id_key unique (business_id, id),
  constraint review_pin_carries_once unique (business_id, comment_id, to_revision_id),
  constraint review_pin_carries_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint review_pin_carries_review_fkey foreign key (business_id, review_id)
    references public.reviews (business_id, id),
  constraint review_pin_carries_comment_fkey foreign key (business_id, comment_id)
    references public.records (business_id, id),
  constraint review_pin_carries_from_fkey foreign key (business_id, review_id, from_revision_id)
    references public.review_revisions (business_id, review_id, id),
  constraint review_pin_carries_to_fkey foreign key (business_id, review_id, to_revision_id)
    references public.review_revisions (business_id, review_id, id),
  constraint review_pin_carries_lease_fkey foreign key (business_id, lease_id)
    references public.leases (business_id, id),
  constraint review_pin_carries_actor_fkey foreign key (business_id, carried_by_actor_id)
    references public.actors (business_id, id),
  constraint review_pin_carries_onward check (from_revision_id <> to_revision_id),
  constraint review_pin_carries_state_known check (state in ('moved', 'lost')),
  constraint review_pin_carries_lost_has_no_anchor
    check ((state = 'lost') = (anchor is null)),
  constraint review_pin_carries_anchor_on_its_revision
    check (anchor is null or anchor ->> 'source' = to_revision_id::text)
);

create index review_pin_carries_to_idx on public.review_pin_carries (business_id, to_revision_id);

alter table public.review_pin_carries enable row level security;
alter table public.review_pin_carries force row level security;

create policy tenancy_review_pin_carries on public.review_pin_carries
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_review_pin_carries on public.review_pin_carries
  as permissive for all using (true) with check (true);

grant select, insert on public.review_pin_carries to ops_astro_app;
