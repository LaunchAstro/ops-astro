-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0051 C81: the data-class register, and the privacy policy's versions
-- reading it.
--
-- One row per class of personal information the business holds: why it is
-- held (purpose), to whom it is normally disclosed, how long it is kept
-- (retention) and how it is deleted. Each is required, here and in the
-- tracked action `privacy.set_data_class` under `privacy:manage`
-- (`commands/data-class-write.ts`), so a class missing one is refused. A
-- class the business no longer holds is kept, marked not in use, and never
-- deleted. C62's retention table and the privacy-request workflows (C61-R)
-- read this register through `operations/data-classes.ts`.
--
-- A privacy-policy version is drafted with the classes in use
-- (`data_classes`) and their digest (`data_classes_digest`), both written
-- once with the rest of the draft beside the overseas-services register
-- (0050). Approving or publishing it is refused once the classes' digest has
-- moved since the draft (`operations/legal-documents.ts`).

create table public.data_classes (
  business_id       uuid        not null,
  id                uuid        not null,
  data_class        text        not null,
  purpose           text        not null,
  disclosures       text        not null,
  retention         text        not null,
  deletion          text        not null,
  in_use            boolean     not null,
  updated_at        timestamptz not null default now(),
  updated_by_actor  uuid        not null,
  constraint data_classes_pkey primary key (id),
  constraint data_classes_tenant_id_key unique (business_id, id),
  constraint data_classes_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint data_classes_actor_fkey foreign key (business_id, updated_by_actor)
    references public.actors (business_id, id),
  constraint data_classes_class_present check (length(btrim(data_class)) between 1 and 120),
  constraint data_classes_purpose_present check (length(btrim(purpose)) between 1 and 2000),
  constraint data_classes_disclosures_present check (length(btrim(disclosures)) between 1 and 2000),
  constraint data_classes_retention_present check (length(btrim(retention)) between 1 and 2000),
  constraint data_classes_deletion_present check (length(btrim(deletion)) between 1 and 2000)
);

-- One row per class, whatever its letter case.
create unique index data_classes_one_class
  on public.data_classes (business_id, lower(data_class));

alter table public.data_classes enable row level security;
alter table public.data_classes force row level security;

create policy tenancy_data_classes on public.data_classes
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_data_classes on public.data_classes
  as permissive
  for all
  using (true)
  with check (true);

-- Set by insert or update; never deleted.
grant select, insert, update on public.data_classes to ops_astro_app;

alter table public.legal_document_versions
  add column data_classes jsonb,
  add column data_classes_digest text,
  add constraint legal_document_versions_data_classes_policy_only check (
    (document = 'privacy-policy') = (data_classes_digest is not null)
    and (data_classes is null) = (data_classes_digest is null)
  );

-- Written once, now with the classes the draft was made from.
create or replace function public.legal_document_versions_written_once() returns trigger
  language plpgsql
  as $$
  begin
    if (new.business_id, new.id, new.document, new.version, new.body, new.body_digest,
        new.drafted_at, new.drafted_by_actor, new.register, new.register_digest,
        new.data_classes, new.data_classes_digest)
       is distinct from
       (old.business_id, old.id, old.document, old.version, old.body, old.body_digest,
        old.drafted_at, old.drafted_by_actor, old.register, old.register_digest,
        old.data_classes, old.data_classes_digest)
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
