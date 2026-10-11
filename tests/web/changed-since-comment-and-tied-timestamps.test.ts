// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import type { InternalTaskDetail } from '../../packages/core-wire/src/index.ts';
import { changedSince } from '../../apps/web/src/screens/task/Notices.tsx';

const AT = '2026-10-04T01:00:00.000Z';
const before: InternalTaskDetail = {
  id: 'task',
  key: 'TSK-1',
  title: 'Original',
  description: null,
  agentBrief: null,
  state: null,
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 4,
  history: [
    {
      eventId: 'e-create',
      at: AT,
      actorId: 'actor-ada',
      personId: 'person-ada',
      actorKind: 'person',
      actorName: 'Ada',
      operation: 'task.create',
    },
  ],
  comments: [],
  proposals: [],
  capCurrency: null,
  envelope: null,
  alerts: [],
  ledger: null,
  rank: { number: null, score: null, calc: '' },
  adHoc: false,
  clientAccess: false,
  board: null,
  stage: null,
  clientSet: false,
  client: null,
  hasContent: true,
  steps: [],
  time: null,
  tags: [],
  agent: null,
  myAgents: [],
  pageLink: null,
  estimateMinutes: null,
  category: null,
};
const names = new Map([['person-ben', 'Ben']]);

// Sol OW-091.4 criterion correctness, retitled by what it proves; its body is Sol's.
it('a comment-only change is reported without a task revision bump', () => {
  // writeTaskComment returns the unchanged target revision; only the comments
  // grow. This is the real task.comment read contract.
  const now: InternalTaskDetail = {
    ...before,
    comments: [
      {
        id: 'comment',
        audience: 'internal',
        author: 'Ben',
        body: 'New note',
        comment_type: 'note',
        posted_at: '2026-10-04T01:00:01.000Z',
        edited_at: null,
        source: 'web',
        parent: null,
        signal: null,
        own: false,
      },
    ],
    // A comment is not a change to the task, so the history does not grow
    // (U116): the notice cannot name who wrote it, and says someone did.
    history: before.history,
  };
  expect(now.revision).toBe(before.revision);
  expect(changedSince(before, now, names)).toEqual({ who: ['someone'], what: ['a comment'] });
});

// Sol OW-091.5 criterion 5, retitled by what it proves; its body is Sol's.
it('history additions sharing a timestamp still name their actor', () => {
  // historyOf orders by audit seq and converts its Date to ISO milliseconds.
  // Distinct applied events can therefore have the same wire timestamp.
  const now: InternalTaskDetail = {
    ...before,
    revision: 5,
    title: 'Changed by Ben',
    history: [
      ...before.history,
      {
        eventId: 'e-update',
        at: AT,
        actorId: 'actor-ben',
        personId: 'person-ben',
        actorKind: 'person',
        actorName: 'Ben',
        operation: 'task.update',
      },
    ],
  };
  expect(changedSince(before, now, names)).toEqual({ who: ['Ben'], what: ['title'] });
});
