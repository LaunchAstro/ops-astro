-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Owner line 72 by source (#1619): the owner's GPT session is a cloud route
-- carried by a subscription, and an unpriced conversation call on it is
-- recorded as the cloud route it is, never relabelled local. 0107 let an
-- unpriced conversation call record only `local`; this lets it record `cloud`
-- too, and only with a `subscription` credential. Holding nothing, and every
-- other scope rule, is unchanged. Every row 0107 admitted is admitted here.

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
           or (reserved_minor = 0
               and (route_reach = 'local'
                    or (route_reach = 'cloud' and credential_kind = 'subscription'))))));
