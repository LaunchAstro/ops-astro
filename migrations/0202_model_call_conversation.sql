-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0202 a model call from a person's own conversation (AW-01's conversation
-- seam, ORCH35 option a). SL11's 0048, numbered after SL12's 0052 where the
-- two stack (ORCH38); the batch 3 join sets the final numbers.
--
-- A conversation has no task lease, run, step or approved version, and no
-- money moves on it: its calls take local routes only and hold nothing. So a
-- row is exactly one of two scopes:
--
-- * a task call: run, step, lease, version and reservation all set, no
--   conversation (every row before this migration);
-- * a conversation call: the conversation set, those five null, no
--   delegation (the person in their own session only), a local route, and
--   nothing held.
--
-- `conversation_id` has no foreign key here: the conversations table is
-- SL12's, and the key (business_id, conversation_id) joins at the batch 3
-- join. The broker checks the conversation's business and owner against
-- the authenticated caller before any row is written.

alter table public.model_calls
  alter column run_id drop not null,
  alter column step_id drop not null,
  alter column lease_id drop not null,
  alter column version_id drop not null,
  alter column reservation_id drop not null,
  add column conversation_id uuid;

alter table public.model_calls
  add constraint model_calls_one_scope check (
    (conversation_id is null
      and run_id is not null and step_id is not null and lease_id is not null
      and version_id is not null and reservation_id is not null)
    or (conversation_id is not null
      and run_id is null and step_id is null and lease_id is null
      and version_id is null and reservation_id is null
      and delegation_id is null
      and route_reach = 'local'
      and reserved_minor = 0));

-- A task call holds its priced maximum unless refused; a conversation call
-- holds nothing and is never recorded as a refusal.
alter table public.model_calls drop constraint model_calls_hold_only_when_refused;
alter table public.model_calls
  add constraint model_calls_hold_only_when_refused check (
    case when conversation_id is null then (reserved_minor = 0) = (state = 'refused')
         else state <> 'refused' end);

create index model_calls_conversation_idx
  on public.model_calls (business_id, conversation_id)
  where conversation_id is not null;
