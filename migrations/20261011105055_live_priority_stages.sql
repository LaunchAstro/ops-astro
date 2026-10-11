-- SPDX-License-Identifier: AGPL-3.0-only
--
-- P11: a change to the business's priority stages re-ranks every open task
-- (×1.25 for a task in a priority stage), with no task row written. So the
-- write says `business:settings:priority_stages` on the live channel (0035),
-- and each board stream of that business runs its one rule at once: it
-- digests what its reader sees (`boardReach`, which takes the setting's
-- revision) and says `resync` only when that moved. The payload names the
-- setting alone, never a value; who is told is decided by the digest.

create function public.live_priority_stages()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  perform pg_notify('ops_astro_live', new.business_id::text || ':settings:priority_stages');
  return null;
end;
$$;

revoke all on function public.live_priority_stages() from public;

create trigger business_settings_priority_live
  after update on public.business_settings
  for each row
  when (new.key = 'priority_stages' and old.revision is distinct from new.revision)
  execute function public.live_priority_stages();
