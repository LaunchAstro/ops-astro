-- SPDX-License-Identifier: AGPL-3.0-only
--
-- AW-11: a helper's work on its parent's run. The parent's holder handing
-- part of its work to a helper (`delegated`) and the helper's result or
-- partial work landing back on the parent's run (`child_handed_back`) are
-- run events like the claim and the handback: handles only, written in the
-- transaction that makes them, under the task lock.

alter table public.run_events drop constraint run_events_kind_known;
alter table public.run_events add constraint run_events_kind_known
  check (kind in ('claimed', 'handed_back', 'dropped', 'reactivated', 'delegated',
                  'child_handed_back'));
