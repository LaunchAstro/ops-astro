// SPDX-License-Identifier: AGPL-3.0-only
//
// Time tracking (MP-4-6): a stub, red before the commands.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';

type TimeContext = Pick<CommandContext, 'session'>;

const STUB = (): Promise<HandlerOutcome> =>
  Promise.resolve(refused(refuseCommand('NOT_FOUND', [], ['Not built yet.'])));

export const startTime = (
  _tx: TenantQuery,
  _context: TimeContext,
  _taskId: string,
): Promise<HandlerOutcome> => STUB();
export const stopTime = (
  _tx: TenantQuery,
  _context: TimeContext,
  _taskId: string,
): Promise<HandlerOutcome> => STUB();
export const logTimeEntry = (
  _tx: TenantQuery,
  _context: TimeContext,
  _taskId: string,
  _duration: unknown,
  _note: unknown,
): Promise<HandlerOutcome> => STUB();
export const setEntryNote = (
  _tx: TenantQuery,
  _context: TimeContext,
  _entryId: string,
  _note: unknown,
): Promise<HandlerOutcome> => STUB();
export const deleteEntry = (
  _tx: TenantQuery,
  _context: TimeContext,
  _entryId: string,
): Promise<HandlerOutcome> => STUB();
