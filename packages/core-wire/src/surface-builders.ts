// SPDX-License-Identifier: AGPL-3.0-only
//
// The two builders every `COMMAND_SURFACE` row is made with, and the default
// collection they fall back to (moved whole from `surface.ts` for the line cap).

import type { Action } from '../../core-records/src/index.ts';
import type { CommandName } from './command-names.ts';
import type { CommandDeclaration } from './surface-declaration.ts';
import { WRITE_OPERANDS } from './write-operands.ts';

export const TASK_COLLECTION = 'task';

export function declare(
  name: CommandName,
  action: Action,
  options: {
    readonly collection?: string;
    readonly targetsExistingRecord?: boolean;
    readonly authorisedOn?: CommandDeclaration['authorisedOn'];
    readonly targetLock?: CommandDeclaration['targetLock'];
    readonly serialise?: string;
    readonly untargetedIdentifiers?: readonly string[];
    readonly runtimeShaped?: string;
    readonly agent?: CommandDeclaration['agent'];
    readonly authority?: readonly string[];
    readonly rule?: string;
    readonly audited?: boolean;
  } = {},
): CommandDeclaration {
  const targetsExistingRecord = options.targetsExistingRecord ?? true;
  return {
    operands: WRITE_OPERANDS[name] ?? {},
    ...(options.untargetedIdentifiers === undefined
      ? {}
      : { untargetedIdentifiers: options.untargetedIdentifiers }),
    ...(options.runtimeShaped === undefined ? {} : { runtimeShaped: options.runtimeShaped }),
    ...(options.serialise === undefined ? {} : { serialise: options.serialise }),
    ...(options.authority === undefined ? {} : { authority: options.authority }),
    ...(options.rule === undefined ? {} : { rule: options.rule }),
    name,
    kind: 'write',
    collection: options.collection ?? TASK_COLLECTION,
    targetsExistingRecord,
    authorisedOn: options.authorisedOn ?? (targetsExistingRecord ? 'record' : 'business'),
    targetLock: options.targetLock ?? 'command',
    action,
    agent: options.agent ?? 'never',
    audited: options.audited ?? true,
  };
}

/**
 * A read. It takes the `read` action on the collection it names, targets no
 * revision. It is authorised on the business unless it
 * names one task, which `reads/dispatch.ts` asks about at record scope; the
 * read path decides that from its catalogue row, and
 * `tests/commands/read-authorised-on.test.ts` holds this field to it.
 */
export function read(
  name: CommandName,
  collection: string,
  options: {
    readonly action?: Action;
    readonly agent?: CommandDeclaration['agent'];
    readonly authorisedOn?: 'record' | 'business' | 'self';
    readonly authority?: readonly string[];
    readonly audited?: boolean;
  } = {},
): CommandDeclaration {
  return {
    ...(options.authority === undefined ? {} : { authority: options.authority }),
    name,
    kind: 'read',
    collection,
    targetsExistingRecord: false,
    authorisedOn: options.authorisedOn ?? 'business',
    targetLock: 'command',
    action: options.action ?? 'read',
    agent: options.agent ?? 'never',
    // Every read writes its event (`reads/dispatch.ts`, I13), but a person's
    // own preferences (CS-2.8).
    audited: options.audited ?? true,
  };
}
