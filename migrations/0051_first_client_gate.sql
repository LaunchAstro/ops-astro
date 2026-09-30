-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0051 S0-5: the gate before the first real client data and the first client
-- invite.
--
-- Both tables are about the installation, not a business, so they live in
-- `ops` beside the migration ledger, which the application's role cannot
-- reach. The readiness value is derived here on every read and stored
-- nowhere a person or agent can write.
--
-- `ops.installation` holds one row: the mode. A made-up-data installation
-- (staging, the test harness) runs every command; a real-data installation
-- refuses every command the catalogue classes `client-data` or `invitation`
-- while any gate item is open (`commands/first-client-gate.ts`). The mode
-- moves one way only, from made-up to real, and only while every item is
-- done; back is refused for everyone, the database owner included, so the
-- mode can never be used to get round the gate. The row cannot be deleted.
--
-- `ops.gate_items` holds one row per item done, with its evidence link. An
-- item with no row is open.

create table ops.installation (
  singleton  boolean     not null default true,
  mode       text        not null,
  changed_at timestamptz not null default now(),
  constraint installation_pkey primary key (singleton),
  constraint installation_one_row check (singleton),
  constraint installation_mode_known check (mode in ('made-up', 'real'))
);

create table ops.gate_items (
  item        text        not null,
  evidence    text        not null,
  recorded_at timestamptz not null default now(),
  constraint gate_items_pkey primary key (item),
  constraint gate_items_item_known check (item in (
    'tested-backups', 'second-factor', 'legal-basics', 'privacy-act-statement',
    'overseas-register', 'breach-runbook', 'security-pass', 'phone-alerts'
  )),
  constraint gate_items_evidence_link check (
    evidence ~ '^https://[^[:space:]]+$' and length(evidence) <= 2000
  )
);

-- The mode and the open items, read together. SECURITY DEFINER so the
-- application's role reads the answer without reaching either table; executable
-- by that role alone.
create function public.first_client_readiness(out mode text, out open_items text[])
  language sql
  stable
  security definer
  set search_path = pg_catalog, ops
as $$
  select i.mode,
         array(
           select wanted.item from unnest(array[
             'tested-backups', 'second-factor', 'legal-basics', 'privacy-act-statement',
             'overseas-register', 'breach-runbook', 'security-pass', 'phone-alerts'
           ]) as wanted(item)
            where not exists (select 1 from ops.gate_items g where g.item = wanted.item)
            order by wanted.item
         )
    from ops.installation i
$$;

revoke all on function public.first_client_readiness() from public;
grant execute on function public.first_client_readiness() to ops_astro_app;

create function ops.installation_one_way() returns trigger
  language plpgsql
  set search_path = pg_catalog, ops
as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') or old.mode = 'real' and new.mode is distinct from 'real' then
    raise exception 'INSTALLATION_MODE_ONE_WAY: a real-data installation stays real';
  end if;
  if old.mode = 'made-up' and new.mode = 'real'
     and cardinality((select r.open_items from public.first_client_readiness() r)) > 0 then
    raise exception 'INSTALLATION_NOT_READY: every gate item must be done first';
  end if;
  return new;
end;
$$;

revoke all on function ops.installation_one_way() from public;

create trigger installation_one_way
  before update or delete on ops.installation
  for each row execute function ops.installation_one_way();

create trigger installation_not_truncated
  before truncate on ops.installation
  for each statement execute function ops.installation_one_way();

-- Provisioned made-up. A real-data installation is made by the one-way change.
insert into ops.installation (mode) values ('made-up');
