-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0034 the alert record (T2h). A run's transition into settled, failed or
-- cancelled, or into a wait only a person can end, raises one alert on its
-- task, in the transaction that made the transition (`core-runtime/src/alerts.ts`).
-- Progress raises none. The task page and the queue read show them; nothing
-- delivers them (C12-6: no inbox, no email).
--
-- `cause_id` is the row whose transition raised it: the attempt for a
-- settlement or a hand-back, the lineage for a cancellation. One alert per
-- cause and kind, so a transition replayed cannot raise a second.
--
-- An alert is a record of what happened: the application role may insert and
-- read it, never change or delete it. Nothing here touches the gate, gate
-- decision or proposal tables (spike RN-12). No function is created. The
-- worker holds nothing on it.

create table public.alerts (
  business_id    uuid        not null,
  id             uuid        not null,
  task_id        uuid        not null,
  kind           text        not null,
  waiting_reason text,
  cause_id       uuid        not null,
  raised_at      timestamptz not null default now(),
  constraint alerts_pkey primary key (id),
  constraint alerts_tenant_id_key unique (business_id, id),
  constraint alerts_one_per_transition unique (business_id, cause_id, kind),
  constraint alerts_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint alerts_task_fkey foreign key (business_id, task_id)
    references public.records (business_id, id),
  constraint alerts_kind_known
    check (kind in ('settled', 'failed', 'cancelled', 'awaiting_person')),
  constraint alerts_reason_only_when_waiting
    check ((kind = 'awaiting_person') = (waiting_reason is not null)),
  constraint alerts_waiting_reason_known
    check (waiting_reason in ('needs_approval', 'liability_unknown', 'quarantined'))
);

create index alerts_business_idx on public.alerts (business_id);
create index alerts_task_idx on public.alerts (business_id, task_id, raised_at);

alter table public.alerts enable row level security;
alter table public.alerts force row level security;

create policy tenancy_alerts on public.alerts
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_alerts on public.alerts
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert on public.alerts to ops_astro_app;
