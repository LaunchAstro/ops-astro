-- SPDX-License-Identifier: AGPL-3.0-only
--
-- A conversation's started work (`conversation-work.ts`) reaches the run and
-- gate of a plan accepted in it through the plan record, whose origin only the
-- record holds. Every wrap-up and purge check reads it under the
-- conversation's row lock, so it is indexed as planned_runs and gates are
-- (`0092_conversations`) rather than read across the whole business.

create index plan_records_origin_conversation_idx
  on public.plan_records (business_id, origin_conversation_id)
  where origin_conversation_id is not null;
