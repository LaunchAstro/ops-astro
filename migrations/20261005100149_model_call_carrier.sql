-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 20261005054843 a model call records the provider and credential that carried it (AW-10, catalogue #439, #943).
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
-- The broker also writes `account` (0085) at the send now, as custody names
-- it for the credential before sending, where until now only a priced answer
-- wrote it. With the three, the pass asks only through the route that carried
-- the call and releases only when custody answers on the same account. A row
-- missing any of them (written before this, or a `replay` credential, which
-- has no account) releases nothing: a person records its outcome.
-- No table, role, policy or grant is added: the columns live on the call's
-- row, under its business's row security and the table's grants (0085).

alter table public.model_calls add column provider text;
alter table public.model_calls add column credential_ref text;
