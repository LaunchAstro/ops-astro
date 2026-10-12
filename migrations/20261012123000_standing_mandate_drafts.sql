-- SPDX-License-Identifier: AGPL-3.0-only
--
-- One standing mandate per filing (#1427). The screen mints a draft id once
-- per form intent and sends it on every retry of that filing, whatever
-- operation id carries it. `standing_mandate_drafts` binds each draft to the
-- mandate its filing was answered with, so a repeat of the draft is answered
-- with that mandate, or refused once it is revoked or expired, and never files
-- a second one. A binding is written once, in the filing's own transaction.
--
-- The binding names its mandate through the client as well as the business:
-- `standing_mandates_client_id_key` is a key over columns the table already
-- has, so `standing_mandates_written_once` and the insert grants are
-- unchanged, and a Client A draft cannot name Client B's mandate.

alter table public.standing_mandates
  add constraint standing_mandates_client_id_key unique (business_id, client_id, id);

create table public.standing_mandate_drafts (
  business_id uuid        not null,
  client_id   uuid        not null,
  draft_id    uuid        not null,
  mandate_id  uuid        not null,
  bound_at    timestamptz not null default clock_timestamp(),
  constraint standing_mandate_drafts_pkey primary key (business_id, client_id, draft_id),
  constraint standing_mandate_drafts_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint standing_mandate_drafts_mandate_fkey foreign key (business_id, client_id, mandate_id)
    references public.standing_mandates (business_id, client_id, id)
);

create function public.standing_mandate_drafts_written_once() returns trigger
  language plpgsql
  as $$
  begin
    raise exception 'IMMUTABLE_FIELD: a standing mandate draft is bound once'
      using errcode = 'restrict_violation';
  end;
  $$;

revoke execute on function public.standing_mandate_drafts_written_once() from public;

create trigger standing_mandate_drafts_written_once
  before update or delete on public.standing_mandate_drafts
  for each row execute function public.standing_mandate_drafts_written_once();

alter table public.standing_mandate_drafts enable row level security;
alter table public.standing_mandate_drafts force row level security;

create policy tenancy_standing_mandate_drafts on public.standing_mandate_drafts
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_standing_mandate_drafts on public.standing_mandate_drafts
  as permissive for all using (true) with check (true);

-- Bound with its own fields only: `bound_at` is the database's.
grant select, insert (business_id, client_id, draft_id, mandate_id)
  on public.standing_mandate_drafts to ops_astro_app;
