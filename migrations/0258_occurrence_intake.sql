-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0258 an event refused at intake (C33, U36; #483 point 4).
--
-- Each business's event intake is a bounded queue: its approved events whose
-- run is not yet dispatched, at most 1,000 (FIRING_LIMITS in
-- core-records automations/occurrences.ts). An event past the bound is
-- refused at intake and recorded as an occurrence with this outcome, never
-- dropped unseen; it starts no run and names no approval. A run over the
-- ceiling writes nothing: its occurrence stays approved with no dispatch,
-- which is how it shows as waiting, so the ceiling needs no column here.
-- Numbered after SL13's 0257; the batch 3 join numbers it again.

alter table public.activation_occurrences
  drop constraint activation_occurrences_outcome_known,
  add constraint activation_occurrences_outcome_known
    check (outcome in ('started', 'activation_off', 'no_standing_approval', 'approved',
                       'over_activation_rate', 'over_business_rate', 'over_intake_bound'));
