-- SPDX-License-Identifier: AGPL-3.0-only
--
-- C35 (capture half, #2011, part B): a capture claimed by one worker lease,
-- landed under that lease alone, and the picture it keeps.
--
-- Pictures are kept in `storage_objects`, the bounded database provider
-- behind the storage seam (`core-records/src/review/storage.ts`): bytes by id,
-- business scoped, capped in size here as well as in the provider. A row
-- names an object by id only, never a path.

create table public.storage_objects (
  business_id uuid        not null,
  id          uuid        not null,
  digest      text        not null,
  byte_count  integer     not null,
  body        bytea       not null,
  created_at  timestamptz not null default now(),
  constraint storage_objects_pkey primary key (id),
  constraint storage_objects_tenant_id_key unique (business_id, id),
  constraint storage_objects_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint storage_objects_bounded
    check (byte_count between 1 and 524288 and octet_length(body) = byte_count)
);

alter table public.review_captures
  add column lease_id       uuid,
  add column fence          bigint,
  add column observation    jsonb,
  add column picture_id     uuid,
  add column picture_digest text,
  add column landed_at      timestamptz,
  add constraint review_captures_lease_fkey foreign key (business_id, lease_id)
    references public.leases (business_id, id),
  add constraint review_captures_picture_fkey foreign key (business_id, picture_id)
    references public.storage_objects (business_id, id),
  add constraint review_captures_claim_whole
    check ((state = 'requested') = (lease_id is null) and (lease_id is null) = (fence is null)),
  add constraint review_captures_land_whole check (
    (state = 'landed') = (landed_at is not null)
    and (landed_at is null) = (observation is null)
    and (landed_at is null) = (picture_id is null)
    and (picture_id is null) = (picture_digest is null)
  );

create index review_captures_lease_idx on public.review_captures (business_id, lease_id);

alter table public.storage_objects enable row level security;
alter table public.storage_objects force row level security;

create policy tenancy_storage_objects on public.storage_objects
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_storage_objects on public.storage_objects
  as permissive for all using (true) with check (true);

-- A picture is written once and removed only through the seam; a capture
-- only moves.
grant select, insert, delete on public.storage_objects to ops_astro_app;
grant update (state, lease_id, fence, observation, picture_id, picture_digest, landed_at, updated_at)
  on public.review_captures to ops_astro_app;

-- A capture moves requested -> claimed -> landed, a claim may pass to a later
-- lease only while the capture is not landed, and a landed capture keeps what
-- it landed. The revision and the width are fixed.
create or replace function public.review_captures_moves()
  returns trigger
  language plpgsql
  security invoker
  set search_path = pg_catalog, public
as $$
begin
  if (new.business_id, new.id, new.revision_id, new.width, new.asked_by_actor_id,
      new.asked_by_person_id, new.created_at)
     is distinct from
     (old.business_id, old.id, old.revision_id, old.width, old.asked_by_actor_id,
      old.asked_by_person_id, old.created_at) then
    raise exception 'review_captures_moves: capture % keeps its revision and width', old.id;
  end if;
  if old.state = 'landed' then
    raise exception 'review_captures_moves: capture % is landed', old.id;
  end if;
  if not ((old.state in ('requested', 'claimed') and new.state = 'claimed')
          or (old.state = 'claimed' and new.state = 'landed'
              and new.lease_id = old.lease_id and new.fence = old.fence)) then
    raise exception 'review_captures_moves: capture % cannot move from % to %',
      old.id, old.state, new.state;
  end if;
  return new;
end;
$$;

revoke all on function public.review_captures_moves() from public;

create trigger review_captures_moves
  before update on public.review_captures
  for each row execute function public.review_captures_moves();
