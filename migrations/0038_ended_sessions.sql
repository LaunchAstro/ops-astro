-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0038 ended sessions (C58, TR-SEC-3). A person sees their sessions and ends
-- the others, signs out of this one, and a second-factor change ends the
-- others. A session is the sign-in provider's `session_id` claim, which a
-- refresh carries unchanged.
--
-- `authentication_attempts.session_id` is the session a resolved attempt came
-- in on. It is how a person's sessions are seen: the provider gives a person
-- no list of their own, so the list is the distinct sessions this business has
-- served them in the last 12 hours.
--
-- `ended_sessions` is one row per session ended here. Login resolution refuses
-- a session named in it from the commit (`AUTH_SESSION_EXPIRED`), so an
-- ended session's access token, and any a refresh mints for it, is refused at
-- once rather than at its expiry; the provider's sign-out, which revokes the
-- refresh tokens, comes after and cannot undo it. A person ends only their
-- own: the row names them, and resolution asks for their own row.
--
-- Written once; never changed or deleted.

alter table public.authentication_attempts add column session_id uuid;

-- What the list reads: one person's recent sessions.
create index authentication_attempts_person_sessions
  on public.authentication_attempts (business_id, person_id, at)
  where session_id is not null;

create table public.ended_sessions (
  business_id  uuid        not null,
  id           uuid        not null default gen_random_uuid(),
  person_id    uuid        not null,
  session_id   uuid        not null,
  reason       text        not null,
  ended_at     timestamptz not null default now(),
  constraint ended_sessions_pkey primary key (id),
  constraint ended_sessions_tenant_id_key unique (business_id, id),
  constraint ended_sessions_session_key unique (business_id, person_id, session_id),
  constraint ended_sessions_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint ended_sessions_person_fkey foreign key (business_id, person_id)
    references public.people (business_id, id),
  constraint ended_sessions_reason_known check (
    reason in ('sign_out', 'end_others', 'factor_change')
  )
);

alter table public.ended_sessions enable row level security;
alter table public.ended_sessions force row level security;

create policy tenancy_ended_sessions on public.ended_sessions
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_ended_sessions on public.ended_sessions
  as permissive
  for all
  using (true)
  with check (true);

-- No update or delete: an ended session stays ended.
grant select, insert on public.ended_sessions to ops_astro_app;
