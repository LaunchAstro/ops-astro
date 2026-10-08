// SPDX-License-Identifier: AGPL-3.0-only
import type { TaskBoardResult } from '../../packages/core-wire/src/index.ts';
import { randomUUID } from 'node:crypto';
import { scopeCommand, scopeRead, type ScopeWorld } from './typed-todo-scope-world.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
export class BoardDestinations {
  readonly w: ScopeWorld;
  constructor(w: ScopeWorld) {
    this.w = w;
  }
  async revision(id: string): Promise<number> {
    const rows = await this.w.db.app.withBusiness(this.w.business, (tx) =>
      tx.query<{ readonly revision: string }>(
        'select revision::text from records where business_id = $1 and id = $2',
        [this.w.business, id],
      ),
    );
    return Number(rows[0]?.revision);
  }
  async command(body: Parameters<typeof scopeCommand>[1]): Promise<string> {
    const answer = await scopeCommand(this.w, body);
    if (isCommandRefusal(answer) || answer.recordId === null)
      throw new Error(`Destination fixture refused ${JSON.stringify(answer)}`);
    return answer.recordId;
  }
  async read(body: Readonly<Record<string, unknown>>): Promise<TaskBoardResult> {
    const answer = await scopeRead(this.w, { read: 'task.board', ...body });
    if (isCommandRefusal(answer) || !('tasks' in answer))
      throw new Error(`Expected board tasks ${JSON.stringify(answer)}`);
    return answer;
  }
  async seed(): Promise<{
    readonly boardA: string;
    readonly boardB: string;
    readonly tasks: readonly string[];
  }> {
    const boardA = await this.command({
      command: 'task.create',
      fields: { title: 'Aggregate board A' },
    });
    const boardB = await this.command({
      command: 'task.create',
      fields: { title: 'Aggregate board B' },
    });
    const tasks: string[] = [];
    for (const board of [boardA, boardB, null]) {
      // eslint-disable-next-line no-await-in-loop -- each task's revisioned commands finish before the next task.
      const id = await this.command({
        command: 'task.create',
        fields: { title: 'Aggregate admitted work' },
        ...(board === null ? {} : { board }),
      });
      // eslint-disable-next-line no-await-in-loop -- party precedes assignment.
      let expectedRevision = await this.revision(id);
      // eslint-disable-next-line no-await-in-loop -- the owning operation uses its freshly read revision.
      await this.command({
        command: 'task.set_party',
        recordId: id,
        expectedRevision,
        fields: { client: this.w.clientA },
      });
      // eslint-disable-next-line no-await-in-loop -- assignment follows party.
      expectedRevision = await this.revision(id);
      // eslint-disable-next-line no-await-in-loop -- each operation retains revision custody.
      await this.command({
        command: 'task.assign',
        recordId: id,
        expectedRevision,
        fields: { assignee: this.w.teammate.personId },
      });
      // eslint-disable-next-line no-await-in-loop -- scores follow assignment.
      expectedRevision = await this.revision(id);
      // eslint-disable-next-line no-await-in-loop -- canonical scores are written by their owning operation.
      await this.command({
        command: 'task.set_scores',
        recordId: id,
        expectedRevision,
        fields: { impact: tasks.length + 2, confidence: 8, ease: 7 },
      });
      tasks.push(id);
    }
    return { boardA, boardB, tasks };
  }
  async archived(): Promise<string> {
    const parent = await this.command({
      command: 'task.create',
      fields: { title: 'Aggregate archived parent' },
    });
    const step = await this.command({
      command: 'task.create',
      parentId: parent,
      fields: { title: 'Aggregate archived step' },
    });
    await this.command({
      command: 'task.assign',
      recordId: step,
      expectedRevision: await this.revision(step),
      fields: { assignee: this.w.teammate.personId },
    });
    await this.command({
      command: 'task.complete',
      recordId: parent,
      expectedRevision: await this.revision(parent),
    });
    return step;
  }
  async cancelled(): Promise<string> {
    const stateId = randomUUID();
    await this.w.db.app.withBusiness(this.w.business, (tx) =>
      tx.query(
        `insert into records (business_id,id,record_type_id,data)
      select $1,$2,record_type_id,$3 from records where business_id=$1 and data->>'machine_category'='completed' limit 1`,
        [
          this.w.business,
          stateId,
          { key: 'cancelled', label: 'Cancelled', machine_category: 'cancelled', position: 6000 },
        ],
      ),
    );
    const recordId = await this.command({
      command: 'task.create',
      fields: { title: 'Aggregate cancelled work' },
    });
    await this.command({
      command: 'task.assign',
      recordId,
      expectedRevision: await this.revision(recordId),
      fields: { assignee: this.w.teammate.personId },
    });
    await this.command({
      command: 'task.set_state',
      recordId,
      expectedRevision: await this.revision(recordId),
      stateId,
    });
    return recordId;
  }
}
