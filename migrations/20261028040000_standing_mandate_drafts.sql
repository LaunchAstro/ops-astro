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

-- A filing with no binding yet is judged by content: the client's unrevoked,
-- unexpired mandate with exactly these classes (as a set), refusal, ceiling,
-- currency, expiry, label and graduation class. Compared whole, never by a
-- hash or a prefix. Volatile, so each call reads the database's clock and a
-- fresh snapshot after its caller's client lock.
create function public.standing_mandate_live_filing(
  business uuid, client uuid, words text[], refusal boolean, ceiling bigint, money text,
  expiry timestamptz, sentence text, graduation text
) returns uuid
  language sql volatile
  set search_path = pg_catalog
  as $$
    select m.id from public.standing_mandates m
     where m.business_id = business and m.client_id = client
       and m.revoked_at is null and m.expires_at > clock_timestamp()
       and m.refuses = refusal
       and m.ceiling_minor is not distinct from ceiling
       and m.currency is not distinct from money
       and m.graduation_class is not distinct from graduation
       and m.expires_at = expiry and m.label = sentence
       and array(select distinct word from unnest(m.classes) as word order by word)
           = array(select distinct word from unnest(words) as word order by word)
     order by m.created_at, m.id
     limit 1
  $$;

revoke execute on function public.standing_mandate_live_filing(
  uuid, uuid, text[], boolean, bigint, text, timestamptz, text, text) from public;
grant execute on function public.standing_mandate_live_filing(
  uuid, uuid, text[], boolean, bigint, text, timestamptz, text, text) to ops_astro_app;

-- The backstop for a writer that skips the command: a second live mandate
-- identical to one already filed is refused, judged after the client's lock.
-- The lock is a write of the client's row, unchanged, as
-- 20261007035000_mapping_claims_its_login.sql claims a login: a row lock
-- alone does not refresh a repeatable read snapshot, so a second writer whose
-- snapshot predates the first's commit would find nothing and file too. Under
-- read committed it waits and then reads a fresh snapshot; under repeatable
-- read or serializable it fails with `serialization_failure` and retries.
create function public.standing_mandates_one_live_filing() returns trigger
  language plpgsql
  as $$
  begin
    update public.clients k set no_agent_edits = k.no_agent_edits
      where k.business_id = new.business_id and k.id = new.client_id;
    if public.standing_mandate_live_filing(new.business_id, new.client_id, new.classes,
         new.refuses, new.ceiling_minor, new.currency, new.expires_at, new.label,
         new.graduation_class) is not null then
      raise exception 'a live standing mandate already carries this filing'
        using errcode = 'unique_violation', constraint = 'standing_mandates_one_live_filing';
    end if;
    return new;
  end;
  $$;

revoke execute on function public.standing_mandates_one_live_filing() from public;

create trigger standing_mandates_one_live_filing
  before insert on public.standing_mandates
  for each row execute function public.standing_mandates_one_live_filing();
