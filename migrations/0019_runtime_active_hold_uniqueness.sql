-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0019 one *active* hold per version, not one hold ever.
--
-- 0013's `reservations_version_idx` is unique on `(business_id, version_id)`
-- with no predicate, so a version that has ever been reserved can never be
-- reserved again. That reads like the duplicate-hold guard W01 wants, and it
-- is stricter than the contract: T3 says that "where a previous reservation is
-- already terminal, create a fresh attempt and hold under current budget
-- authority", and T5 says replacement work "never revives an abandoned
-- reservation" -- it gets a new one. An expired lease whose hold was
-- classified therefore left its still-approved version permanently unclaimable
-- (R5), which is a lifecycle the schema forbade rather than a rule anyone
-- accepted.
--
-- The partial index is the accepted rule stated exactly: at most one hold on a
-- version that is still live. `abandoned`, `actual` and `quarantined` rows are
-- history and do not block a replacement; two concurrent holds still cannot
-- exist, which is the duplicate the original index was defending against.
--
-- Additive: it drops an index and creates one, and rewrites no earlier file.

drop index public.reservations_version_idx;

create unique index reservations_one_active_per_version_idx
  on public.reservations (business_id, version_id)
  where state in ('held', 'quarantined');
