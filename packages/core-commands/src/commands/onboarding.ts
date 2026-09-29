// SPDX-License-Identifier: AGPL-3.0-only
//
// New client onboarding (C41-A): the named tests come first, so each command
// answers that it has not landed until it is built.

import type { EntryPoint, TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';

const notLanded = (): HandlerOutcome =>
  refused(refuseCommand('DEPENDENCY_NOT_LANDED', ['onboarding'], ['C41-A is being built.']));

export async function createRecord(
  _tx: TenantQuery,
  _context: CommandContext,
  _request: { readonly type?: unknown; readonly fields: Readonly<Record<string, unknown>> },
): Promise<HandlerOutcome> {
  return await Promise.resolve(notLanded());
}

export async function startOnboarding(
  _tx: TenantQuery,
  _context: CommandContext,
  _request: { readonly clientId: string; readonly templateKey?: unknown },
): Promise<HandlerOutcome> {
  return await Promise.resolve(notLanded());
}

export async function writeStepResult(
  _tx: TenantQuery,
  _author: {
    readonly actorId: string;
    readonly actorKind: 'person' | 'agent';
    readonly entryPoint: EntryPoint;
    readonly commentTypeId: string | undefined;
  },
  _request: { readonly recordId: string; readonly outcome?: unknown; readonly result?: unknown },
): Promise<HandlerOutcome> {
  return await Promise.resolve(notLanded());
}

export async function recordStepResult(
  _tx: TenantQuery,
  _context: CommandContext,
  _request: { readonly recordId: string; readonly outcome?: unknown; readonly result?: unknown },
): Promise<HandlerOutcome> {
  return await Promise.resolve(notLanded());
}
