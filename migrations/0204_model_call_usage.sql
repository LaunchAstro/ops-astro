-- SPDX-License-Identifier: AGPL-3.0-only
--
-- AW-01 (ORCH37, for MP-14-9 and MP-14-6): a settled model call records the
-- model the provider says answered and the units its answer says it used. The
-- priced settle writes all three in the transaction that settles the money
-- (`core-custody/src/broker-settle.ts`); nothing else writes them, so a
-- released, refused or held call carries none.
--
--   model_id      as the answer named it, or null when it named none. The
--                 adapter refuses an answer whose model id is out of this
--                 shape as malformed; the database holds the same shape.
--   input_units   and
--   output_units  whole numbers, both or neither.
-- Was 0050; renumbered after this stack's 0054 when SL11 took b0/SL12
-- (ORCH38); the batch 3 join numbers it again.

alter table public.model_calls
  add column model_id text,
  add column input_units bigint,
  add column output_units bigint;

alter table public.model_calls
  add constraint model_calls_model_id_shape
    check (model_id is null or model_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  add constraint model_calls_units_whole
    check ((input_units is null) = (output_units is null)
           and (input_units is null or (input_units >= 0 and output_units >= 0)));
