// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { AssignmentCustody } from '../../apps/web/src/screens/task/assignment-custody.ts';
import { CommentCustody } from '../../apps/web/src/screens/task/comment-custody.ts';
import { ScoresCustody } from '../../apps/web/src/screens/task/scores-custody.ts';
import { BoardEditCustody } from '../../apps/web/src/screens/projects/board-edit-custody.ts';
import { timerCustody } from '../../apps/web/src/screens/task/task-timer-custody.ts';
import { TaskTimer } from '../../apps/web/src/screens/task/task-timer.ts';
import { store } from './draft-support.tsx';

const TASK = '11111111-1111-4111-8111-111111111111';
const PERSON = '22222222-2222-4222-8222-222222222222';
const pause = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
const oldOwner = 'alpha:ada@example.test:0';
/** Every custodian holds one lost change for the old owner in the shared tab storage. */
async function holdAsOldOwner(original: OperationsClient, storage: ReturnType<typeof store>) {
  const assignments = new AssignmentCustody(original, oldOwner, storage);
  await assignments.choose(TASK, 4, { assignee: PERSON });
  const comments = new CommentCustody(original, oldOwner, storage);
  await comments.post(TASK, {
    operationId: original.newOperationId(),
    revision: 4,
    body: 'Private words',
    audience: 'internal',
    kind: 'note',
    parentId: null,
  });
  const scores = new ScoresCustody(original, oldOwner, storage);
  scores.choose(TASK, 4, 'impact', 10);
  const board = new BoardEditCustody(original, oldOwner, storage);
  board.choose(
    { command: 'task.update', body: { recordId: TASK, fields: { title: 'Private title' } } },
    4,
  );
  new TaskTimer(original, () => true, timerCustody(storage, oldOwner)).start({ id: TASK });
  await pause();
}
for (const owner of ['bravo:ada@example.test:0', 'alpha:bob@example.test:0']) {
  it(`recovery does not cross to ${owner}`, async () => {
    const storage = store();
    const requests: string[] = [];
    const client = (businessKey: string) =>
      new OperationsClient({
        origin: '',
        businessKey,
        signedIn: true,
        fetch: (url) => {
          requests.push(String(url));
          return Promise.reject(new TypeError('lost'));
        },
      });
    const original = client('alpha');
    await holdAsOldOwner(original, storage);
    const current = client(owner.split(':')[0]!);
    const nextAssignments = new AssignmentCustody(current, owner, storage);
    const nextComments = new CommentCustody(current, owner, storage);
    const nextScores = new ScoresCustody(current, owner, storage);
    const nextBoard = new BoardEditCustody(current, owner, storage);
    const nextTimer = new TaskTimer(current, () => true, timerCustody(storage, owner));
    expect(nextAssignments.snapshot().holds.size).toBe(0);
    expect(nextComments.snapshot(TASK).pending).toBeNull();
    expect(nextScores.snapshot(TASK).pending).toBeNull();
    expect(nextBoard.snapshot().holds.size).toBe(0);
    expect(nextBoard.snapshot().problem).not.toBeNull();
    expect(nextTimer.snapshot().attempt).toBeNull();
    const sent = requests.length;
    await nextAssignments.retry(TASK);
    nextScores.retry(TASK);
    await nextBoard.retry(TASK);
    nextTimer.retry();
    await pause();
    expect(requests).toHaveLength(sent);
  });
}
