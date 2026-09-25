-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0024 an envelope holds money in its cap's currency.
--
-- 0013 links an envelope to its cap by `(business_id, cap_id)` alone, and the
-- application role may insert and update both tables. So storage accepts a USD
-- envelope under an AUD cap, and a cap whose currency changes beneath the
-- envelopes that already draw on it, after which AUD held amounts are counted
-- against a USD ceiling (Sol 6 RUNTIME P2 at 0395827). The cap is a ceiling in
-- one currency. `task.decide` refuses a version in another currency with
-- `CAP_BINDING_MISMATCH` before its first write (`core-runtime/src/budget.ts`);
-- the code refuses first so the caller gets a reason, and this refuses second
-- so a writer that got around the code gets nothing. Nathan approved it.
--
-- The envelope's `(business_id, cap_id, currency)` references the cap's
-- `(business_id, id, currency)`. With no action on update, a cap's currency is
-- fixed once any envelope draws on it; a cap nothing draws on may still change.
-- The existing `task_envelopes_cap_fkey` stays: it is history, and it names the
-- cap alone.
--
-- Additive, and validated as it is added. A fresh database and an upgraded one
-- hold the same rule over the same rows: an installation already holding an
-- envelope in another currency than its cap's fails this migration, naming the
-- constraint, and stays at 0023 with its rows untouched. Nothing is rewritten
-- to make it pass. Grants are unchanged.

alter table public.budget_caps
  add constraint budget_caps_tenant_currency_key unique (business_id, id, currency);

alter table public.task_envelopes
  add constraint task_envelopes_cap_currency_fkey foreign key (business_id, cap_id, currency)
    references public.budget_caps (business_id, id, currency);
