// SPDX-License-Identifier: AGPL-3.0-only
//
// The shape of a write's handler, shared by `handlers.ts` and the blocks it
// spreads in (`handlers-wayfinder.ts`), so neither imports the other's types.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import type { HandlerOutcome } from './outcome.ts';

/**
 * Each write's request, by name. An intersection rather than `Extract`, so the
 * one union member that five owning operations share narrows to each of them.
 */
export type WriteName = CommandRequest['command'];
export type RequestOf<K extends WriteName> = CommandRequest & { readonly command: K };

export type Handler<K extends WriteName> = (
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<K>,
) => Promise<HandlerOutcome>;
