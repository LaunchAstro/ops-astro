-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The launched agent takes its launch (`task.take_launch`). The take moves a
-- waiting launch to `started` and records when, and what for: `answer`, the
-- one kind of run there is. Under a delegation whose launch was taken for
-- `answer`, the agent entry admits reading the task and the run's own command
-- and nothing else (`agent-authority.ts`), so the record of the take is what
-- the server holds the run to.
--
-- A launch that can no longer run when it is taken is ended there, and why is
-- kept, so the take answers the same receipt after a lost answer. A launch
-- ended any other way (the next Launch of the task ending a lapsed one) keeps
-- no cause.
--
-- No launch is `started` before this migration on any installation, since
-- nothing took one; one that is refuses the upgrade rather than leaving a
-- started launch that no take recorded.

do $$
begin
  if exists (select 1 from public.task_launches where state = 'started') then
    raise exception 'task_launches: a started launch predates the take, so it cannot be recorded as taken';
  end if;
end
$$;

alter table public.task_launches
  add column taken_at timestamptz,
  add column taken_for text,
  add column ended_cause text,
  add constraint task_launches_taken_for_known check (taken_for is null or taken_for = 'answer'),
  add constraint task_launches_taken_together check ((taken_at is null) = (taken_for is null)),
  add constraint task_launches_started_when_taken check (state <> 'started' or taken_at is not null),
  add constraint task_launches_ended_cause_known check (
    ended_cause is null
    or (state = 'ended' and ended_cause in ('client', 'trashed', 'lapsed', 'revoked', 'settled', 'narrowed', 'agent_off'))),
  add constraint task_launches_delegation_key unique (business_id, id, delegation_id);
