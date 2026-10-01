-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0043 the inbox on the live channel (INB-1f).
--
-- A raised, cleared or withdrawn item tells its recipient's open tabs that
-- their inbox changed, on T2f's channel and under its rules: `pg_notify` is
-- delivered at commit, never on a rollback, and carries no content. The topic
-- is the recipient, `business:inbox:person`, and the fan-out hands it only to
-- that person's own streams in that business. Items change in bulk (a decision
-- clears every holder's item at once), so this runs per statement and names
-- each recipient once.

create function public.live_inbox_topics()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  perform pg_notify('ops_astro_live', topic)
     from (select distinct changed.business_id::text || ':inbox:'
                  || changed.recipient_person_id::text as topic
             from changed) as topics;
  return null;
end;
$$;

revoke all on function public.live_inbox_topics() from public;

create trigger inbox_items_live_insert after insert on public.inbox_items
  referencing new table as changed
  for each statement execute function public.live_inbox_topics();

create trigger inbox_items_live_update after update on public.inbox_items
  referencing new table as changed
  for each statement execute function public.live_inbox_topics();
