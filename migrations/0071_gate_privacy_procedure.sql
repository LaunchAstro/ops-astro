-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0071 S0-5: item 3's tested manual privacy-request procedure gets its own
-- line in the first-client gate (`docs/build-safeguards.md`, item 3: access,
-- correction, erasure, export, legal hold and retention by hand, in force
-- until C61-R, C62 and C84 are live; the runbook is C81's).
--
--   privacy-procedure  the procedure's dry run, with its evidence link.
--
-- Item 3 is one row with one link, so it could be done with the procedure
-- untested. The line is a row in `ops.gate_items` like any item, recorded
-- through the same command with an https link and no owner's line (0060's
-- `gate_items_statement` already refuses one off the three closing lines),
-- and the readiness function lists it as open until it is recorded. Grants
-- are unchanged: the function keeps its owner and its execute grant.

alter table ops.gate_items drop constraint gate_items_item_known;
alter table ops.gate_items add constraint gate_items_item_known check (item in (
  'tested-backups', 'second-factor', 'legal-basics', 'privacy-act-statement',
  'overseas-register', 'breach-runbook', 'security-pass', 'phone-alerts',
  'privacy-opt-in', 'cloudflare-rolled', 'training-line', 'privacy-procedure'
));

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
             'privacy-opt-in', 'cloudflare-rolled', 'training-line', 'privacy-procedure'
           ]) as wanted(item)
            where not exists (select 1 from ops.gate_items g where g.item = wanted.item)
            order by wanted.item
         )
    from ops.installation i
$$;
