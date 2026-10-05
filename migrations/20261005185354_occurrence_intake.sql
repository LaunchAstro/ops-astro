-- SPDX-License-Identifier: AGPL-3.0-only
-- A UTC timestamp ID (docs/local/DATA.md, "What the schema is"): b0/SL13's
-- 0258, ported onto main after migrations moved to timestamps, with the two
-- rate outcomes 20261005184526 left out.
--
-- C33's limits on firing (#483 point 4), each read back from the records
-- under AW-01's durable limit, so no counter lives here. An occurrence past
-- its activation's hourly rate or its business's is recorded with the rate it
-- is over and starts no run. Each business's event intake is a bounded queue:
-- its approved events whose run is not yet dispatched, at most 1,000
-- (FIRING_LIMITS in core-records automations/occurrences.ts). An event past
-- the bound is refused at intake and recorded with that outcome, never
-- dropped unseen. None of the three names an approval. A run over the
-- business's ceiling writes nothing: its occurrence stays approved with no
-- dispatch, which is how it shows as waiting, so the ceiling needs no column.

alter table public.activation_occurrences
  drop constraint activation_occurrences_outcome_known,
  add constraint activation_occurrences_outcome_known
    check (outcome in ('started', 'activation_off', 'no_standing_approval', 'approved',
                       'over_activation_rate', 'over_business_rate', 'over_intake_bound'));
