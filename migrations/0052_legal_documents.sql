-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0052 C81: the legal documents, each a run of versions.
--
-- A version is drafted, approved as those exact bytes, and published, and each
-- step is a tracked action under `privacy:manage` (`commands/legal-write.ts`).
-- A version's words never change once written, drafted or published: a change
-- is a new version the owner approves. The guard below holds that here rather
-- than in a command, so no later entry point can edit a published document in
-- place, and nothing is ever deleted.
--
-- `body_digest` is the SHA-256 of the words, set by the database on insert, so
-- an approval names the bytes the approver read and publishing can check the
-- approval was of these bytes. The client terms, the privacy policy (with its
-- collection notices) and the data-handling statement are public once
-- published; the breach runbook is for the operators only.

create table public.legal_document_versions (
  business_id         uuid        not null,
  id                  uuid        not null,
  document            text        not null,
  version             text        not null,
  body                text        not null,
  body_digest         text        not null,
  drafted_at          timestamptz not null default now(),
  drafted_by_actor    uuid        not null,
  approved_at         timestamptz,
  approved_by_actor   uuid,
  approved_digest     text,
  published_at        timestamptz,
  published_by_actor  uuid,
  constraint legal_document_versions_pkey primary key (id),
  constraint legal_document_versions_tenant_id_key unique (business_id, id),
  constraint legal_document_versions_one_label unique (business_id, document, version),
  constraint legal_document_versions_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint legal_document_versions_drafter_fkey foreign key (business_id, drafted_by_actor)
    references public.actors (business_id, id),
  constraint legal_document_versions_approver_fkey foreign key (business_id, approved_by_actor)
    references public.actors (business_id, id),
  constraint legal_document_versions_publisher_fkey foreign key (business_id, published_by_actor)
    references public.actors (business_id, id),
  constraint legal_document_versions_document_known check (
    document in ('client-terms', 'privacy-policy', 'data-handling', 'breach-runbook')
  ),
  constraint legal_document_versions_version_shape check (version ~ '^[0-9]{1,3}\.[0-9]{1,3}$'),
  constraint legal_document_versions_body_present
    check (length(btrim(body)) between 1 and 200000),
  constraint legal_document_versions_approval_whole check (
    (approved_at is null) = (approved_by_actor is null)
    and (approved_at is null) = (approved_digest is null)
  ),
  constraint legal_document_versions_approved_these_bytes
    check (approved_digest is null or approved_digest = body_digest),
  constraint legal_document_versions_publication_whole
    check ((published_at is null) = (published_by_actor is null)),
  constraint legal_document_versions_published_after_approval
    check (published_at is null or approved_at is not null)
);

create index legal_document_versions_current
  on public.legal_document_versions (business_id, document, published_at desc)
  where published_at is not null;

-- The digest is the database's, from the words as stored.
create function public.legal_document_versions_digest() returns trigger
  language plpgsql
  as $$
  begin
    new.body_digest := encode(sha256(convert_to(new.body, 'UTF8')), 'hex');
    return new;
  end;
  $$;

revoke execute on function public.legal_document_versions_digest() from public;

create trigger legal_document_versions_digest
  before insert on public.legal_document_versions
  for each row execute function public.legal_document_versions_digest();

-- Written once: the draft's columns never change, and the approval and the
-- publication are each set once and never changed or cleared.
create function public.legal_document_versions_written_once() returns trigger
  language plpgsql
  as $$
  begin
    if (new.business_id, new.id, new.document, new.version, new.body, new.body_digest,
        new.drafted_at, new.drafted_by_actor)
       is distinct from
       (old.business_id, old.id, old.document, old.version, old.body, old.body_digest,
        old.drafted_at, old.drafted_by_actor)
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

create trigger legal_document_versions_written_once
  before update on public.legal_document_versions
  for each row execute function public.legal_document_versions_written_once();

alter table public.legal_document_versions enable row level security;
alter table public.legal_document_versions force row level security;

create policy tenancy_legal_document_versions on public.legal_document_versions
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_legal_document_versions on public.legal_document_versions
  as permissive
  for all
  using (true)
  with check (true);

-- Drafted, then approved and published by update; never deleted.
grant select, insert, update on public.legal_document_versions to ops_astro_app;
