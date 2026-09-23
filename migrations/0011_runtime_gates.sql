-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0011 gates. The approval point, bound to the exact run and the exact version
-- digest it was raised for.
--
-- The binding is the mechanism. A gate that names only a task can be approved
-- after the proposal it was raised over has been replaced, and the approver's
-- "yes" then authorises work they never read (G04). So `gates` carries
-- `version_id`, `run_id` and `payload_digest` together, the digest is checked
-- against the version's own under the decision's locks, and a superseding
-- version marks the old gate superseded rather than leaving it pending.
--
-- Expiry is the database's clock, not the caller's (G06). `expires_at` is a
-- stored column and the decision compares it to `now()` inside the deciding
-- transaction, so a client with a slow clock or a cached expiry cannot turn an
-- expired gate into an approved one. Nothing here expires a gate on a timer:
-- a pending gate past its expiry is refused when someone tries to decide it,
-- and no timer approves anything.

create table public.gates (
  business_id    uuid        not null,
  id             uuid        not null,
  lineage_id     uuid        not null,
  version_id     uuid        not null,
  run_id         uuid        not null,
  step_id        uuid        not null,
  evidence_pack_id uuid      not null,
  payload_digest text        not null,
  state          text        not null default 'pending',
  round          integer     not null default 1,
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now(),
  decided_at     timestamptz,
  constraint gates_pkey primary key (id),
  constraint gates_tenant_id_key unique (business_id, id),
  constraint gates_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint gates_lineage_fkey foreign key (business_id, lineage_id)
    references public.proposal_lineages (business_id, id),
  constraint gates_version_fkey foreign key (business_id, version_id)
    references public.proposal_versions (business_id, id),
  constraint gates_run_fkey foreign key (business_id, run_id)
    references public.planned_runs (business_id, id),
  constraint gates_step_fkey foreign key (business_id, step_id)
    references public.planned_steps (business_id, id),
  constraint gates_evidence_fkey foreign key (business_id, evidence_pack_id)
    references public.evidence_packs (business_id, id),
  constraint gates_digest_shaped check (payload_digest ~ '^[0-9a-f]{64}$'),
  constraint gates_state_known
    check (state in ('pending', 'approved', 'rejected', 'changes_requested', 'superseded', 'expired')),
  -- A gate that is still pending has not been decided, and one that is not
  -- pending was. Two columns that can disagree about whether a decision
  -- happened is one column too many.
  constraint gates_decided_is_dated check ((state = 'pending') = (decided_at is null)),
  -- Two formal rounds, and the third is refused before it is written (G08).
  -- The cap is a constraint as well as a check in `decide.ts` so a later
  -- handler that forgets it is refused by the server.
  constraint gates_round_bounded check (round between 1 and 3)
);

-- One gate per version. A second gate on one version is a second place to say
-- yes, and G03's "first decision wins" then depends on which one the caller
-- happened to name.
create unique index gates_version_idx on public.gates (business_id, version_id);

create index gates_business_idx on public.gates (business_id);

create index gates_pending_idx
  on public.gates (business_id, lineage_id)
  where state = 'pending';

alter table public.gates enable row level security;
alter table public.gates force row level security;

create policy tenancy_gates on public.gates
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_gates on public.gates
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update on public.gates to ops_astro_app;
