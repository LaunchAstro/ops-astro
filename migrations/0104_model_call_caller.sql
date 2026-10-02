-- SPDX-License-Identifier: AGPL-3.0-only
--
-- AW-11: a model call records whose delegation made it. A helper spends on its
-- parent's lease, at its fence, on its reservation (d71424f), so the call's
-- `delegation_id` is the parent's: the one ledger and the one ceiling. The
-- caller's own delegation is kept beside it, so the execution graph can put a
-- helper's calls under the parent's run as the helper's steps.
--
--   caller_delegation_id   the delegation the broker's caller presented: the
--                          lease's own for its holder, the child's for a
--                          helper; null for a call no delegation made (a
--                          person's conversation call).
--
-- Written once by the broker's reserve (`core-custody/src/broker-reserve.ts`)
-- and never updated.

alter table public.model_calls
  add column caller_delegation_id uuid,
  add constraint model_calls_caller_delegation_fkey foreign key (business_id, caller_delegation_id)
    references public.delegations (business_id, id);

create index model_calls_caller_delegation_idx
  on public.model_calls (business_id, caller_delegation_id)
  where caller_delegation_id is not null;
