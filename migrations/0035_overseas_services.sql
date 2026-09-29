-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0035 C81: the overseas-services register (SP-25), and the privacy policy's
-- versions reading it.
--
-- One row per outside service that receives personal information: what it
-- receives, where it is stored, whether it trains on it and the contract that
-- covers it. A row is set by the tracked action `privacy.set_overseas_service`
-- under `privacy:manage` (`commands/overseas-write.ts`), so every change is an
-- audited operation; a service the installation no longer turns on is kept,
-- marked not in use, and never deleted. A row still marked "to confirm" is
-- listed but holds the privacy policy back.
--
-- A privacy-policy version is drafted with the register as it stood: the rows
-- in use (`register`) and their digest (`register_digest`), both written once
-- with the rest of the draft. Approving or publishing it is refused while any
-- of those rows is to confirm, or once the register's digest has moved since
-- the draft (`operations/legal-documents.ts`). The other documents carry no
-- register.

create table public.overseas_services (
  business_id       uuid        not null,
  id                uuid        not null,
  service           text        not null,
  receives          text        not null,
  stored_where      text        not null,
  trains_on_it      text        not null,
  contract          text        not null,
  to_confirm        boolean     not null,
  in_use            boolean     not null,
  updated_at        timestamptz not null default now(),
  updated_by_actor  uuid        not null,
  constraint overseas_services_pkey primary key (id),
  constraint overseas_services_tenant_id_key unique (business_id, id),
  constraint overseas_services_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint overseas_services_actor_fkey foreign key (business_id, updated_by_actor)
    references public.actors (business_id, id),
  constraint overseas_services_service_present check (length(btrim(service)) between 1 and 120),
  constraint overseas_services_receives_present check (length(btrim(receives)) between 1 and 2000),
  constraint overseas_services_where_present check (length(btrim(stored_where)) between 1 and 1000),
  constraint overseas_services_trains_present check (length(btrim(trains_on_it)) between 1 and 1000),
  constraint overseas_services_contract_present check (length(btrim(contract)) between 1 and 1000)
);

-- One row per service, whatever its letter case.
create unique index overseas_services_one_service
  on public.overseas_services (business_id, lower(service));

alter table public.overseas_services enable row level security;
alter table public.overseas_services force row level security;

create policy tenancy_overseas_services on public.overseas_services
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_overseas_services on public.overseas_services
  as permissive
  for all
  using (true)
  with check (true);

-- Set by insert or update; never deleted.
grant select, insert, update on public.overseas_services to ops_astro_app;

alter table public.legal_document_versions
  add column register jsonb,
  add column register_digest text,
  add constraint legal_document_versions_register_policy_only check (
    (document = 'privacy-policy') = (register_digest is not null)
    and (register is null) = (register_digest is null)
  );

-- Written once, now with the register the draft was made from.
create or replace function public.legal_document_versions_written_once() returns trigger
  language plpgsql
  as $$
  begin
    if (new.business_id, new.id, new.document, new.version, new.body, new.body_digest,
        new.drafted_at, new.drafted_by_actor, new.register, new.register_digest)
       is distinct from
       (old.business_id, old.id, old.document, old.version, old.body, old.body_digest,
        old.drafted_at, old.drafted_by_actor, old.register, old.register_digest)
       or (old.approved_at is not null
           and (new.approved_at, new.approved_by_actor, new.approved_digest)
               is distinct from (old.approved_at, old.approved_by_actor, old.approved_digest))
       or (old.published_at is not null
           and (new.published_at, new.published_by_actor)
               is distinct from (old.published_at, old.published_by_actor)) then
      raise exception 'IMMUTABLE_FIELD: a legal document version is written once'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end;
  $$;

revoke execute on function public.legal_document_versions_written_once() from public;
