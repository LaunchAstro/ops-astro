// SPDX-License-Identifier: AGPL-3.0-only
//
// The task type as a model: its classification, its states, and the three
// mechanics that are stated as absences.
//
// The conformance half is negative as well as positive, for the reason T1d
// gave: a set that has only ever seen a conforming schema has not been shown
// to notice anything. Each rule is broken on purpose inside a rolled-back
// transaction and the set is required to name what it caught.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import { taskSpineConformance } from '../../packages/core-records/src/tasks/conformance.ts';
import { domainModelConformance } from '../../packages/core-records/src/records/conformance.ts';
import { readTaskStates, setTaskState } from '../../packages/core-records/src/tasks/state.ts';
import { readFieldDefinitions } from '../../packages/core-records/src/records/field-store.ts';
import { refuseGenericWrite } from '../../packages/core-records/src/records/fields.ts';
import { isRecordsRefusal } from '../../packages/core-records/src/records/refusals.ts';
import {
  describeFindings,
  type Finding,
} from '../../packages/core-records/src/tenancy/conformance.ts';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import { createTask, readSlots } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task model: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

class Rollback extends Error {}

function rules(findings: readonly Finding[]): readonly string[] {
  return findings.map((finding) => finding.rule);
}

describe.skipIf(serverUrl === undefined)('the task model', () => {
  let db: FreshDatabase;
  let businessId: string;
  let taskTypeId: string;
  let taskStateTypeId: string;
  let stateIds: Readonly<Record<string, string>>;

  async function whenTheModelIs(
    breakage: string,
    check: (findings: readonly Finding[]) => void,
  ): Promise<void> {
    try {
      await db.admin.transaction(async (execute: AdminConnection['execute']) => {
        await execute(breakage);
        check(await taskSpineConformance(execute));
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  }

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'e' });
    businessId = await insertBusiness(db.app, 'task-model');
    const spine = await db.app.withBusiness(businessId, async (tx) => await installTaskSpine(tx));
    taskTypeId = spine.taskTypeId;
    taskStateTypeId = spine.taskStateTypeId;
    stateIds = spine.stateIds;
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('the installation', () => {
    it('installs once and returns what is there on a second call', async () => {
      const again = await db.app.withBusiness(businessId, async (tx) => await installTaskSpine(tx));
      expect(again.installed).toBe(false);
      expect(again.taskTypeId).toBe(taskTypeId);
      expect(again.stateIds).toStrictEqual(stateIds);
    });

    it('seeds the legacy’s five status words, ordered for a board', async () => {
      const states = await db.app.withBusiness(
        businessId,
        async (tx) => await readTaskStates(tx, taskStateTypeId),
      );
      expect(states.map((state) => state.key)).toStrictEqual([
        'needs_review',
        'active',
        'waiting_on_client',
        'on_hold',
        'complete',
      ]);
      expect(states.map((state) => state.machineCategory)).toStrictEqual([
        'unstarted',
        'started',
        'started',
        'backlog',
        'completed',
      ]);
      // The legacy's five words reach four of the five categories. Asserted
      // rather than left implicit, so adding a cancelled state is a visible
      // change and not a silent one.
      expect(states.map((state) => state.machineCategory)).not.toContain('cancelled');
    });

    it('leaves T1d’s own conformance set green', async () => {
      const findings = await domainModelConformance(db.admin.execute);
      expect(describeFindings(findings)).toBe('');
    });
  });

  describe('the completion stamp', () => {
    it('is set by moving to a completed state and cleared by moving away', async () => {
      const seen = await db.app.withBusiness(businessId, async (tx) => {
        const spine = await installTaskSpine(tx);
        const task = await createTask(tx, spine, {
          title: 'complete me',
          parentId: null,
          stateKey: 'needs_review',
        });
        const before = (await readSlots(tx, task))['ts_2'];
        const done = await setTaskState(tx, {
          taskId: task,
          stateId: spine.stateIds['complete']!,
          taskStateTypeId: spine.taskStateTypeId,
        });
        const during = await readSlots(tx, task);
        await setTaskState(tx, {
          taskId: task,
          stateId: spine.stateIds['needs_review']!,
          taskStateTypeId: spine.taskStateTypeId,
        });
        const after = await readSlots(tx, task);
        return { before, done, duringStamp: during['ts_2'], duringState: during['uuid_1'], after };
      });
      expect(seen.before).toBeNull();
      expect(isRecordsRefusal(seen.done)).toBe(false);
      expect(seen.duringStamp).not.toBeNull();
      expect(seen.duringState).toBe(stateIds['complete']);
      // Reopening clears the stamp and leaves no key behind that means "not
      // completed": the record simply stops carrying one.
      expect(seen.after['ts_2']).toBeNull();
      expect(seen.after['data']).not.toHaveProperty('completed_at');
      expect(seen.after['uuid_1']).toBe(stateIds['needs_review']);
    });

    it('is refused at the engine every surface reaches, because no operation takes it', async () => {
      const refusal = await db.app.withBusiness(businessId, async (tx) => {
        const fields = await readFieldDefinitions(tx, taskTypeId);
        return refuseGenericWrite(fields, ['title', 'completed_at']);
      });
      expect(refusal?.code).toBe('FIELD_NOT_WRITABLE');
      expect(refusal?.names).toStrictEqual(['completed_at']);
    });

    it('refuses a generic write to each protected field, against the seeded model', async () => {
      const refusals = await db.app.withBusiness(businessId, async (tx) => {
        const fields = await readFieldDefinitions(tx, taskTypeId);
        return [
          'assignee',
          'client',
          'client_visible',
          'delegate',
          'intake_state',
          'parent',
          'stage',
          'state',
        ].map((key) => refuseGenericWrite(fields, [key]));
      });
      for (const refusal of refusals) {
        expect(refusal?.code).toBe('TRANSITION_PROTECTED');
      }
      // The refusal names the operation to call instead, for every one of them.
      expect(refusals.every((refusal) => refusal?.names[0]?.includes('=task.'))).toBe(true);
    });

    it('lets an ordinary edit through, including a section move inside a board', async () => {
      const refusal = await db.app.withBusiness(businessId, async (tx) => {
        const fields = await readFieldDefinitions(tx, taskTypeId);
        return refuseGenericWrite(fields, ['title', 'due', 'priority', 'lane', 'board_section']);
      });
      expect(refusal).toBeUndefined();
    });
  });

  describe('the conformance set', () => {
    it('is green on the installed model', async () => {
      const findings = await taskSpineConformance(db.admin.execute);
      expect(describeFindings(findings)).toBe('');
      expect(findings).toStrictEqual([]);
    });

    it('catches a protected field relaxed to generic', async () => {
      await whenTheModelIs(
        `update public.field_defs set write_mode = 'generic', owning_operation = null
          where record_type_id = '${taskTypeId}' and key = 'assignee'`,
        (findings) => {
          expect(rules(findings)).toContain('no field in the protected set is generic');
        },
      );
    });

    it('catches a second coarse status field appearing on the task', async () => {
      await whenTheModelIs(
        `insert into public.field_defs
           (business_id, id, record_type_id, key, label, value_type, write_mode, origin)
         values ('${businessId}', gen_random_uuid(), '${taskTypeId}', 'status', 'Status',
                 'text', 'generic', 'preset')`,
        (findings) => {
          expect(rules(findings)).toContain(
            'the task carries no run pointer, no clearance and no second coarse status',
          );
        },
      );
    });

    it('catches a run pointer growing back onto the task', async () => {
      await whenTheModelIs(
        `insert into public.field_defs
           (business_id, id, record_type_id, key, label, value_type, write_mode, origin)
         values ('${businessId}', gen_random_uuid(), '${taskTypeId}', 'current_run_id',
                 'Current run', 'uuid', 'generic', 'preset')`,
        (findings) => {
          expect(rules(findings)).toContain(
            'the task carries no run pointer, no clearance and no second coarse status',
          );
        },
      );
    });

    it('catches the completion stamp acquiring an owning operation', async () => {
      await whenTheModelIs(
        `update public.field_defs
            set write_mode = 'operation', owning_operation = array['task.amend_completion']
          where record_type_id = '${taskTypeId}' and key = 'completed_at'`,
        (findings) => {
          expect(rules(findings)).toContain(
            'the completion stamp is derived and no operation takes it as an input',
          );
        },
      );
    });

    it('catches a containment field losing its escalation', async () => {
      await whenTheModelIs(
        `update public.field_defs set escalating_operation = null
          where record_type_id = '${taskTypeId}' and key = 'board'`,
        (findings) => {
          expect(rules(findings)).toContain(
            'a containment field is generic within reach and names the operation that widens it',
          );
        },
      );
    });

    it('catches a third field quietly acquiring one', async () => {
      await whenTheModelIs(
        `update public.field_defs set escalating_operation = 'task.move'
          where record_type_id = '${taskTypeId}' and key = 'lane'`,
        (findings) => {
          expect(rules(findings)).toContain('only the containment fields escalate');
        },
      );
    });

    it('catches an installation with no completed state for task.complete to reach', async () => {
      await whenTheModelIs(
        `update public.records set data = data || '{"machine_category":"started"}'::jsonb
          where record_type_id = '${taskStateTypeId}' and data ->> 'key' = 'complete'`,
        (findings) => {
          expect(rules(findings)).toContain(
            'a state carrying the completed category exists, so a task can be completed',
          );
        },
      );
    });

    it('catches a state carrying a category outside the five', async () => {
      await whenTheModelIs(
        `update public.records set data = data || '{"machine_category":"paused"}'::jsonb
          where record_type_id = '${taskStateTypeId}' and data ->> 'key' = 'on_hold'`,
        (findings) => {
          expect(rules(findings)).toContain(
            'every task state carries one of the five machine categories',
          );
        },
      );
    });

    it('catches the placement invariant being dropped from the database', async () => {
      await whenTheModelIs(
        'alter table public.records drop constraint records_subtask_has_no_board_section',
        (findings) => {
          expect(rules(findings)).toContain(
            'a record with a parent cannot carry a board section, held in the database',
          );
        },
      );
    });

    it('catches a spine field moved out of its reserved slot', async () => {
      await whenTheModelIs(
        `update public.field_defs set slot = 'txt_7'
          where record_type_id = '${taskTypeId}' and key = 'lane'`,
        (findings) => {
          expect(rules(findings)).toContain('a spine field sits in the slot the reservation names');
        },
      );
    });
  });
});
