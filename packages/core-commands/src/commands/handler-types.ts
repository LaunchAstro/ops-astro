// SPDX-License-Identifier: AGPL-3.0-only
//
// The types `handlers.ts` keys its table by, moved whole from it to keep that
// file under the per-file line cap.

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
