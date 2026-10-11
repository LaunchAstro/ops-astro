-- SPDX-License-Identifier: AGPL-3.0-only
--
-- A restore records, on an applied event per restored record, the fields the
-- restore changed: a subtask takes its live parent's board again, so the board
-- it comes back on is named. `task.restore` joins the commands whose applied
-- events may carry `field_changes`; the list is otherwise the one migration
-- 20261011034325 wrote. No function is added, and no event is rewritten.

alter table public.audit_events drop constraint audit_events_field_changes_supported;

alter table public.audit_events add constraint audit_events_field_changes_supported
check (field_changes is null or (
  outcome = 'applied'
  and command in (
    'task.update',
    'task.assign',
    'task.set_stage',
    'task.set_party',
    'task.set_scores',
    'task.set_adhoc',
    'task.set_category',
    'task.triage',
    'task.set_audience',
    'map.scope',
    'task.start',
    'task.complete',
    'task.reopen',
    'task.cancel',
    'task.restart',
    'task.set_state',
    'task.move',
    'task.reparent',
    'task.rank',
    'task.set_type',
    'task.claim',
    'task.set_blocking',
    'task.resolve',
    'task.close_out_of_scope',
    'task.restore'
  )
  and public.audit_field_changes_valid(field_changes)
));
