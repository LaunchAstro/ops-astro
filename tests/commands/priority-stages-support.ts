// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { COMMAND_SURFACE, type CommandDeclaration } from '../../packages/core-wire/src/surface.ts';
import type { SettingView } from '../../packages/core-wire/src/views.ts';
import {
  installBusinessSettings,
  readBusinessSetting,
  type BusinessSetting,
} from '../../packages/core-records/src/records/business-settings.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type {
  CommandHandle,
  CommandResult,
} from '../../packages/core-commands/src/commands/register-store.ts';
import { grantTo, type Member } from './fixture.ts';
import {
  rankCoreWorld,
  rankCommand,
  makeRankTask,
  appliedTask,
  type RankCoreWorld,
} from '../reads/task-rank-core-world.ts';

const COMMAND: string = 'settings.set_priority_stages';
export const KEY = 'priority_stages';

export function priorityDeclaration(): CommandDeclaration {
  const declared = COMMAND_SURFACE.find((one) => one.name === COMMAND);
  if (declared === undefined)
    throw new Error('P10 requires the canonical settings.set_priority_stages declaration');
  return declared;
}

export async function priorityWorld(): Promise<RankCoreWorld> {
  const world = await rankCoreWorld();
  try {
    await world.db.app.withBusiness(world.business, async (tx) => {
      await installBusinessSettings(tx);
      await grantTo(tx, world.owner, 'read', undefined, false, 'settings');
      await grantTo(tx, world.owner, 'manage', undefined, false, 'settings');
    });
    await world.db.app.withBusiness(world.foreign, async (tx) => {
      await installBusinessSettings(tx);
      await grantTo(tx, world.otherOwner, 'read', undefined, false, 'settings');
      await grantTo(tx, world.otherOwner, 'manage', undefined, false, 'settings');
    });
    return world;
  } catch (error) {
    await world.db.drop();
    throw error;
  }
}

export async function setPriority(
  world: RankCoreWorld,
  value: unknown,
  expectedRevision?: number,
  by: Member = world.owner,
  business: string = world.business,
  operationId: string = randomUUID(),
): Promise<CommandResult> {
  return await rankCommand(
    world,
    {
      command: priorityDeclaration().name,
      operationId,
      value,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    },
    by,
    business,
  );
}

export function priorityApplied(result: CommandResult): CommandHandle {
  if (isCommandRefusal(result))
    throw new Error(`P10 setting command refused ${result.code}: ${result.names.join(', ')}`);
  return result;
}

export async function priorityRow(
  world: RankCoreWorld,
  business: string = world.business,
): Promise<BusinessSetting | undefined> {
  return await world.db.app.withBusiness(business, (tx) => readBusinessSetting(tx, KEY));
}

export async function readPriority(
  world: RankCoreWorld,
  by: Member = world.owner,
  business: string = world.business,
): Promise<SettingView> {
  const answer = await executeRead(world.db.app, business, by.presented, {
    read: 'settings.read',
  });
  if (isCommandRefusal(answer) || !('settings' in answer))
    throw new Error('P10 settings.read did not return authorised settings');
  const row = answer.settings.find((one) => one.key === KEY);
  if (row === undefined) throw new Error('P10 settings.read omitted priority_stages');
  return row;
}

export async function priorityTask(
  world: RankCoreWorld,
  stage: string | null,
  marks: readonly [number | null, number | null, number | null] = [7, 9, 8],
  by: Member = world.owner,
  business: string = world.business,
): Promise<ReturnType<typeof appliedTask>> {
  const made = await makeRankTask(world, marks, null, by, business);
  if (stage === null) return made;
  return appliedTask(
    await rankCommand(
      world,
      {
        command: 'task.set_stage',
        recordId: made.id,
        expectedRevision: made.revision,
        fields: { stage },
      },
      by,
      business,
    ),
  );
}
