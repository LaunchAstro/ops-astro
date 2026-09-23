-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0012 the decision chain. Append-only, signed, and hash-linked (G02).
--
-- Three separate mechanisms, because they answer three different questions and
-- a reviewer who is handed one of them tends to assume the other two.
--
-- **Append-only** is the trigger: no update, no delete, at the server. A row a
-- privileged bug can amend is not evidence of what was decided, it is evidence
-- of what the database currently says was decided.
--
-- **Signed** is `signature` over `payload_digest` with the key identity in
-- `signing_key_id`. The key lives outside the database; the column names which
-- key so a verifier can fail on an unknown signer rather than skipping it.
--
-- **Chained** is `prev_hash` / `hash`. A signature proves one row was not
-- edited; the chain proves no row was *removed*, which is the tamper a
-- per-row signature cannot see. `seq` is per business and gapless by the
-- unique index, so a deletion leaves a hole the verifier walks into.
--
-- `decided_by_person_id` is `not null` and there is no actor-only spelling. A
-- person decides (I07, DELEGATION_EXCLUDES_DECISION); an agent has no
-- `person_id` to put here, so the schema refuses the row rather than trusting
-- `decide.ts` to have checked. That is the exclusion held for a third time,
-- after `authority/delegations.ts` and `delegations_never_decide` in 0008.

create table public.gate_decisions (
  business_id        uuid        not null,
  id                 uuid        not null,
  gate_id            uuid        not null,
  version_id         uuid        not null,
  lineage_id         uuid        not null,
  seq                bigint      not null,
  decision           text        not null,
  round              integer     not null,
  decided_by_person_id uuid      not null,
  decided_by_actor_id  uuid      not null,
  payload            jsonb       not null,
  payload_digest     text        not null,
  evidence_digest    text        not null,
  signing_key_id     text        not null,
  signature          text        not null,
  prev_hash          text        not null,
  hash               text        not null,
  decided_at         timestamptz not null default now(),
  constraint gate_decisions_pkey primary key (id),
  constraint gate_decisions_tenant_id_key unique (business_id, id),
  constraint gate_decisions_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint gate_decisions_gate_fkey foreign key (business_id, gate_id)
    references public.gates (business_id, id),
  constraint gate_decisions_version_fkey foreign key (business_id, version_id)
    references public.proposal_versions (business_id, id),
  constraint gate_decisions_lineage_fkey foreign key (business_id, lineage_id)
    references public.proposal_lineages (business_id, id),
  constraint gate_decisions_person_fkey foreign key (business_id, decided_by_person_id)
    references public.people (business_id, id),
  constraint gate_decisions_actor_fkey foreign key (business_id, decided_by_actor_id)
    references public.actors (business_id, id),
  constraint gate_decisions_known
    check (decision in ('approve', 'reject', 'request_changes')),
  constraint gate_decisions_digest_shaped check (payload_digest ~ '^[0-9a-f]{64}$'),
  constraint gate_decisions_hash_shaped check (hash ~ '^[0-9a-f]{64}$'),
  constraint gate_decisions_prev_hash_shaped check (prev_hash ~ '^[0-9a-f]{64}$'),
  constraint gate_decisions_round_bounded check (round between 1 and 3)
);

-- **One decision per gate.** This is what G03 rests on: two concurrent
-- approves serialise on the gate row lock, and if one ever got past the lock
-- the constraint refuses it anyway. The second caller's refusal is recorded as
-- an audit fact by `decide.ts`; it is not a row here, because it is not a
-- decision.
create unique index gate_decisions_one_per_gate_idx
  on public.gate_decisions (business_id, gate_id);

create unique index gate_decisions_seq_idx on public.gate_decisions (business_id, seq);

create index gate_decisions_business_idx on public.gate_decisions (business_id);

create index gate_decisions_lineage_idx on public.gate_decisions (business_id, lineage_id);

-- Append-only, at the server. The application role is granted only `select,
-- insert` below as well; the trigger is the second barrier, for the owner and
-- for any future role somebody grants `update` to without reading this file.
create function public.gate_decisions_are_append_only() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'gate_decisions is append only: decision % cannot be %',
    old.id, lower(tg_op)
    using errcode = 'restrict_violation';
end;
$$;

revoke execute on function public.gate_decisions_are_append_only() from public;

create trigger gate_decisions_append_only
  before update or delete on public.gate_decisions
  for each row execute function public.gate_decisions_are_append_only();

alter table public.gate_decisions enable row level security;
alter table public.gate_decisions force row level security;

create policy tenancy_gate_decisions on public.gate_decisions
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_gate_decisions on public.gate_decisions
  as permissive
  for all
  using (true)
  with check (true);

-- No `update`, no `delete`. A trail that can be amended is not a trail.
grant select, insert on public.gate_decisions to ops_astro_app;
