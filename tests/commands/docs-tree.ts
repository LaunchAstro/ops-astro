// SPDX-License-Identifier: AGPL-3.0-only
//
// What the Docs move tests (#2514) share: a folder made through the command, a business's folder
// tree as id → [parent, name] read by the owner role, and an answer's code or 'applied'.

import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import type { Member } from './fixture.ts';
import type { TimeWorld } from './time-world.ts';

export const codeOrApplied = (answer: CommandResult): string =>
  isCommandRefusal(answer) ? answer.code : 'applied';

export const detailOf = (answer: CommandResult): Record<string, unknown> => {
  if (isCommandRefusal(answer)) throw new Error(`refused ${answer.code}`);
  return answer.detail as Record<string, unknown>;
};

/** A folder `member` makes in `business` through `docs.create_folder`; its id. */
export async function folderIn(
  w: TimeWorld,
  business: BusinessId,
  member: Member,
  name: string,
  parentId?: string,
): Promise<string> {
  const made = await w.as(business, member, {
    command: 'docs.create_folder',
    name,
    ...(parentId === undefined ? {} : { parentId }),
  });
  return String(detailOf(made)['folderId']);
}

/** Every folder of `business` as id → [parent, name]. */
export async function treeOf(
  w: TimeWorld,
  business: BusinessId,
): Promise<Record<string, [string | null, string]>> {
  const rows = await w.db.admin.execute<{
    readonly id: string;
    readonly parent_id: string | null;
    readonly name: string;
  }>('select id, parent_id, name from public.docs_folders where business_id = $1', [business]);
  return Object.fromEntries(rows.map((row) => [row.id, [row.parent_id, row.name]]));
}
