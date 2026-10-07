-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The model a conversation runs on (CS-7.30, the drawer's picker).
--
-- One slot on the conversation, set by `conversation.set_model` from the
-- models `conversation.models` offers it, and null until then: null is the
-- deployment's default model. The exchange reads it, asks the model again
-- whether it is still offered (a client's model egress may have gone off
-- since), and sends it; the run's call records the model the answer named
-- (0098, `model_calls.model_id`). The id holds 0098's shape, so a stored
-- choice is always a model id a call row could hold.
--
-- The conversation's table grants already cover the column (0049: select,
-- insert, update to the application). The purge keeps it, as it keeps the
-- title and the page: which model a conversation used is not what was said.

alter table public.conversations add column model_id text;

alter table public.conversations
  add constraint conversations_model_id_shape
    check (model_id is null or model_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$');
