-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The agent's turn on the owner's ChatGPT plan holds nothing (#2091, design
-- v3, director read DREADPT3OK). The plan is already paid for, so its turn is
-- unpriced, but a task call holds its priced maximum unless refused
-- (`model_calls_hold_only_when_refused`, 0085 and 0096). This narrows that
-- rule by one exception: a task call that is not refused may hold nothing
-- only when it is the agent's turn (`model.agent_turn`) on a cloud route
-- under a subscription. The exception must be true, never unknown, so a row
-- with no credential kind or no reach is refused, as is every other zero
-- hold. A settled zero hold settles at nothing (`model_calls_actual_within_hold`).

alter table public.model_calls drop constraint model_calls_hold_only_when_refused;
alter table public.model_calls
  add constraint model_calls_hold_only_when_refused check (
    case when conversation_id is null then
      case when state = 'refused' then reserved_minor = 0
           else reserved_minor > 0
                or (reserved_minor = 0
                    and credential_kind = 'subscription'
                    and route_reach = 'cloud'
                    and operation_key = 'model.agent_turn') is true
      end
    else state <> 'refused' end);
