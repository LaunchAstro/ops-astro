-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0064 S0-5: the gate's three closing lines, each shut until the owner's
-- evidence is recorded (`docs/build-safeguards.md`, the gate before the first
-- real client data):
--
--   privacy-opt-in     Agency Astro's entry on the OAIC's public Privacy Opt-In
--                      Register (a link to the register, which lists its
--                      entries on the one page), with the owner's line that the
--                      published policy matches it. A lodged form or a receipt
--                      keeps it shut. A line after item 8, not a ninth item.
--   cloudflare-rolled  the old credential refused (the link) and the new one in
--                      custody (the owner's line). Either alone keeps it shut.
--   training-line      the dated line that model training is switched off on
--                      both model accounts (OL-LF5-1, SP-29), with its evidence
--                      link. It belongs to item 5, the overseas register.
--
-- Each is a row in `ops.gate_items`, recorded through the same command, with
-- the owner's one line in `statement`; the eight items carry none. The table
-- holds the same rules the command checks (`gate-write.ts`), so no writer gets
-- round them. The readiness function lists the three as open like any item.

alter table ops.gate_items add column statement text;

alter table ops.gate_items drop constraint gate_items_item_known;
alter table ops.gate_items add constraint gate_items_item_known check (item in (
  'tested-backups', 'second-factor', 'legal-basics', 'privacy-act-statement',
  'overseas-register', 'breach-runbook', 'security-pass', 'phone-alerts',
  'privacy-opt-in', 'cloudflare-rolled', 'training-line'
));

-- The owner's line: one line of at most 500 characters on each closing line,
-- none on the eight items.
alter table ops.gate_items add constraint gate_items_statement check (
  case when item in ('privacy-opt-in', 'cloudflare-rolled', 'training-line')
       then coalesce(length(statement) <= 500 and statement ~ '^[^[:cntrl:]]+$', false)
       else statement is null
  end
);

alter table ops.gate_items add constraint gate_items_opt_in_register check (
  item <> 'privacy-opt-in'
  or evidence ~ '^https://www\.oaic\.gov\.au/privacy/privacy-registers/privacy-opt-in-register/?([?#][^[:space:]]*)?$'
);

alter table ops.gate_items add constraint gate_items_training_line_dated check (
  item <> 'training-line' or coalesce(statement ~ '[0-9]{4}-[0-9]{2}-[0-9]{2}', false)
);

create or replace function public.first_client_readiness(out mode text, out open_items text[])
  language sql
  stable
  security invoker
  set search_path = pg_catalog, ops
as $$
  select i.mode,
         array(
           select wanted.item from unnest(array[
             'tested-backups', 'second-factor', 'legal-basics', 'privacy-act-statement',
             'overseas-register', 'breach-runbook', 'security-pass', 'phone-alerts',
             'privacy-opt-in', 'cloudflare-rolled', 'training-line'
           ]) as wanted(item)
            where not exists (select 1 from ops.gate_items g where g.item = wanted.item)
            order by wanted.item
         )
    from ops.installation i
$$;
