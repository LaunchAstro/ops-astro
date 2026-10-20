-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The owner's typed message on his ChatGPT plan (#2175, money rule P4). A
-- conversation call with no planning envelope was local and held nothing
-- (`model_calls_one_scope`, 0107): AW-03's egress off. This admits one cloud
-- exception, the plan's own conversation operation (`model.chatgpt_plan_answer`)
-- on a cloud route under a subscription, holding nothing, since the plan is
-- already paid for. The exception must be true, never unknown, so a row with
-- no credential kind or no operation key stays refused. The broker writes it
-- only for the owner's own typed message, judged under its locks
-- (`broker-conversation-plan.ts`); every other cloud conversation call is
-- refused here as before.

alter table public.model_calls drop constraint model_calls_one_scope;
alter table public.model_calls
  add constraint model_calls_one_scope check (
    (conversation_id is null and planning_envelope_id is null
      and run_id is not null and step_id is not null and lease_id is not null
      and version_id is not null and reservation_id is not null)
    or (conversation_id is not null
      and run_id is null and step_id is null and lease_id is null
      and version_id is null and reservation_id is null
      and delegation_id is null
      and (planning_envelope_id is not null
           or (route_reach = 'local' and reserved_minor = 0)
           or (route_reach = 'cloud' and reserved_minor = 0
               and credential_kind = 'subscription'
               and operation_key = 'model.chatgpt_plan_answer') is true)));
