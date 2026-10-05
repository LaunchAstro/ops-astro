-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The forwarder replays `ops.api_events` in time order, `(at, id)`, page by
-- page, so the detector's clock never runs backwards between pages
-- (`apps/forwarder/forward.ts`, REPLAY_PAGE). This index is that order: each
-- page reads on from where the last one ended instead of sorting the whole
-- table, so a flood of rows costs the replay in proportion to its size.

create index api_events_at_id_idx on ops.api_events (at, id);
