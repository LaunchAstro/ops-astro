-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 20261005025000 a model call records the provider and credential that carried it (AW-10, catalogue #439, #943).
--
-- The reconciliation pass asks a provider whether it began a call held as
-- unknown liability, and an answer that proves nothing happened releases
-- the call's hold (`reconcileProviderCalls`, core-custody/src/broker-reconcile.ts).
-- That answer proves something only from the account that carried the call.
-- The row recorded the route's key, reach and credential kind, never its
-- provider or credential, so a pass could ask another provider or another
-- account and release a call the first one processed. Two columns now
-- record them, written with the route at every route write:
--   provider        the provider the route sent the call to
--   credential_ref  the custody credential the route presented
-- With them, and `account` (0085) as custody reported it when the call went
-- unknown, the pass asks only through the route that carried the call and
-- releases only when custody reports the same account. Rows written before
-- this have neither, and the pass releases none of them: a person records
-- their outcome.
-- No table, role, policy or grant is added: the columns live on the call's
-- row, under its business's row security and the table's grants (0085).

alter table public.model_calls add column provider text;
alter table public.model_calls add column credential_ref text;
