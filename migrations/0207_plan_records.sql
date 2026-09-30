-- SPDX-License-Identifier: AGPL-3.0-only
--
-- AW-04: the plan a person approved, bound to the decision that approved it.
--
-- One row per plan accept, written in the accept's own transaction beside the
-- gate decision and the run's pin: the exact words the person read (the
-- gate's evidence), the structured plan record derived from them (U4: a new
-- table, protected), and the SHA-256 of each. AW-06's graph projects the
-- record, and refuses one this table does not bind to a decision.
--
-- Nothing here is ever rewritten. The application group may insert and read a
-- row and may never update or delete one; a changed plan is a new version on
-- the gate's lineage, which resets approvals. The worker and broker roles
-- hold nothing on it. The origin conversation is the caller's own, checked by
-- the accept; the run and the gate keep theirs as created.

create table public.plan_records (
  business_id            uuid        not null,
  id                     uuid        not null,
  gate_id                uuid        not null,
  decision_id            uuid        not null,
  run_id                 uuid        not null,
  origin_conversation_id uuid,
  plan_text              text        not null,
  text_digest            text        not null,
  record                 jsonb       not null,
  record_digest          text        not null,
  bound_by_actor_id      uuid        not null,
  bound_at               timestamptz not null default now(),
  constraint plan_records_pkey primary key (business_id, id),
  constraint plan_records_decision_key unique (business_id, decision_id),
  constraint plan_records_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint plan_records_gate_fkey foreign key (business_id, gate_id)
    references public.gates (business_id, id),
  constraint plan_records_decision_fkey foreign key (business_id, decision_id)
    references public.gate_decisions (business_id, id),
  constraint plan_records_run_fkey foreign key (business_id, run_id)
    references public.planned_runs (business_id, id),
  constraint plan_records_origin_conversation_fkey foreign key (business_id, origin_conversation_id)
    references public.conversations (business_id, id),
  constraint plan_records_actor_fkey foreign key (business_id, bound_by_actor_id)
    references public.actors (business_id, id),
  constraint plan_records_text_bounded check (char_length(btrim(plan_text)) between 1 and 20000),
  constraint plan_records_text_digest_shape check (text_digest ~ '^[0-9a-f]{64}$'),
  constraint plan_records_record_shape check (jsonb_typeof(record) = 'object'),
  constraint plan_records_record_digest_shape check (record_digest ~ '^[0-9a-f]{64}$')
);

create index plan_records_gate_idx on public.plan_records (business_id, gate_id);
create index plan_records_run_idx on public.plan_records (business_id, run_id);

alter table public.plan_records enable row level security;
alter table public.plan_records force row level security;

create policy tenancy_plan_records on public.plan_records
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_plan_records on public.plan_records
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert on public.plan_records to ops_astro_app;
