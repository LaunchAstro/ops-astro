-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0018 the handback's own durable record.
--
-- T4 (lines 72-78) says the handback "retains the reported local outcome and
-- evidence", and that a late or superseded holder's report "is retained
-- separately" rather than settling the replacement's work. The head at
-- dcbc8e8 accepted a `report` argument and never read it: the only retained
-- outcome was the short enum on the attempt, so a successful handback threw
-- away the work it had just accepted, and every stale-fence path returned
-- before storing anything at all. L3's digest-only command audit is not a
-- substitute -- it records that a call happened, not what the work produced.
--
-- The table is append-only at the server for the same reason `gate_decisions`
-- is: a report that can be edited after the fact is not evidence of what was
-- handed back, and the application role is granted no update or delete.
--
-- `disposition` is the fact that separates the two cases the contract keeps
-- apart. `settled` is the current owner's report, accepted with the
-- classification. `retained` is a superseded or expired holder's report, kept
-- because the work was really done, and explicitly not a settlement: the
-- refusal that accompanies it is the operation's answer.

create table public.handback_reports (
  business_id    uuid        not null,
  id             uuid        not null,
  lease_id       uuid        not null,
  reservation_id uuid        not null,
  run_id         uuid        not null,
  fence          bigint      not null,
  disposition    text        not null,
  outcome        text        not null,
  refusal_code   text,
  report         jsonb       not null,
  created_at     timestamptz not null default now(),
  constraint handback_reports_pkey primary key (id),
  constraint handback_reports_tenant_id_key unique (business_id, id),
  constraint handback_reports_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint handback_reports_lease_fkey foreign key (business_id, lease_id)
    references public.leases (business_id, id),
  constraint handback_reports_reservation_fkey foreign key (business_id, reservation_id)
    references public.reservations (business_id, id),
  constraint handback_reports_run_fkey foreign key (business_id, run_id)
    references public.planned_runs (business_id, id),
  constraint handback_reports_disposition_known
    check (disposition in ('settled', 'retained')),
  constraint handback_reports_outcome_known
    check (outcome in ('completed', 'failed')),
  -- A retained report is retained *because* something refused it, and a
  -- settled one was not refused. The code and the disposition cannot disagree.
  constraint handback_reports_refusal_matches_disposition
    check ((disposition = 'retained') = (refusal_code is not null))
);

-- One settlement per lease. A retry that reached commit once cannot store a
-- second settled report for the same claim; retained reports are not limited,
-- because a superseded holder may legitimately report more than once and each
-- of those reports is a separate durable fact.
create unique index handback_reports_one_settlement_idx
  on public.handback_reports (business_id, lease_id)
  where disposition = 'settled';

create index handback_reports_business_idx on public.handback_reports (business_id);

create index handback_reports_reservation_idx
  on public.handback_reports (business_id, reservation_id);

alter table public.handback_reports enable row level security;
alter table public.handback_reports force row level security;

create policy tenancy_handback_reports on public.handback_reports
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_handback_reports on public.handback_reports
  as permissive
  for all
  using (true)
  with check (true);

create or replace function public.handback_reports_append_only()
  returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
begin
  raise exception 'handback_reports is append only: report % cannot be %',
    old.id, lower(tg_op);
end;
$$;

revoke all on function public.handback_reports_append_only() from public;

create trigger handback_reports_no_update
  before update or delete on public.handback_reports
  for each row execute function public.handback_reports_append_only();

grant select, insert on public.handback_reports to ops_astro_app;
