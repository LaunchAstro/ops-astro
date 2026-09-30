// SPDX-License-Identifier: AGPL-3.0-only
//
// The shape of the role-and-case matrix's world: the grant pair a declaration
// is checked against, the field it names its subject in, and the `Harness`
// every case is handed. `role-case-harness.ts` builds it and re-exports these,
// so its importers are unchanged; split from it so each stays under the
// per-file cap.

import type { CommandDeclaration, CommandName } from '../../packages/core-wire/src/surface.ts';
import { READ_CATALOGUE, isReadName } from '../../packages/core-commands/src/reads/catalogue.ts';
import type { Answer, Caller, World } from './world.ts';
import type { Prepared, Task } from './role-case-bodies.ts';
import type { FixtureClient } from './role-case-clients.ts';

/**
 * The grant pair a declaration is actually checked against.
 *
 * `preset.plan` is the one declaration whose collection is not the grant it
 * needs: `reads/dispatch.ts` checks `manage` on the family the request names,
 * not on a blanket `preset` collection, because a blanket holder would be
 * admitted to every installed type and the legitimate manager of the task
 * family refused. Everything else takes its own collection.
 */
export const pairFor = (declaration: CommandDeclaration): string =>
  `${declaration.name === 'preset.plan' ? 'task' : declaration.collection}:${declaration.action}`;

/**
 * The field a declaration names its subject in: `recordId` on a targeted
 * command, and on a record-scoped read the identifier its catalogue row takes.
 * `task.receipt` names its task through `attemptId`, and a `recordId` beside
 * it is refused `COMMAND_BODY_INVALID` before authority, so a case that sent
 * one would measure that refusal instead of its own.
 */
export function targetKeyOf(declaration: CommandDeclaration): string | undefined {
  if (declaration.targetsExistingRecord) return 'recordId';
  if (declaration.kind !== 'read' || declaration.authorisedOn !== 'record') return undefined;
  return isReadName(declaration.name) ? READ_CATALOGUE[declaration.name].identifiers[0] : undefined;
}

export interface Harness {
  readonly world: World;
  /** A live alpha task and a live bravo record, for the cases that need a real id. */
  readonly alphaTask: Task;
  readonly bravoRecordId: string;
  /** Who holds what, read back from `grants` rather than from the fixture's list. */
  readonly heldBy: ReadonlyMap<string, ReadonlySet<string>>;
  /** Everyone but the admin, in the order case (e) sweeps them. */
  readonly otherCallers: readonly Caller[];
  /** T4a's two clients in each business, each shown one task (`role-case-clients.ts`). */
  readonly clients: readonly FixtureClient[];
  /** The grant pair a declaration is actually checked against. */
  pairFor(declaration: CommandDeclaration): string;
  asPerson(
    name: CommandName,
    body: Readonly<Record<string, unknown>>,
    businessKey?: string,
    caller?: { readonly token: string },
  ): Promise<Answer>;
  asAgent(
    name: CommandName,
    body: Readonly<Record<string, unknown>>,
    credential?: string,
  ): Promise<Answer>;
  freshTask(title: string): Promise<Task>;
  probeBody(declaration: CommandDeclaration): Readonly<Record<string, unknown>>;
  positiveBody(declaration: CommandDeclaration): Promise<Prepared>;
  approvedReservation(): Promise<{ subject: Task; sibling: Task; decided: Answer }>;
  reserve(task: Task, purpose: string): Promise<Answer>;
  activeRoleKeys(): Promise<readonly string[]>;
  writeBothComments(taskId: string): Promise<readonly Answer[]>;
  close(): Promise<void>;
}
