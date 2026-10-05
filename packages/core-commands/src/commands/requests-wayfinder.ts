// SPDX-License-Identifier: AGPL-3.0-only
//
// The wayfinder commands' requests (WF-1), one member each of
// `CommandRequest`; split from `requests.ts` for the per-file cap. Each
// operand is `any` on its row and checked by value in its `wayfinder*.ts`
// handler, so the refusal names the operand in its own words.

import type { Targeted } from './request-envelope.ts';

export type WayfinderRequest =
  | ({ readonly command: 'task.set_type'; readonly taskType: unknown } & Targeted)
  | ({
      readonly command: 'map.revise';
      readonly destination?: unknown;
      readonly notes?: unknown;
      readonly addFog?: unknown;
      readonly addOutOfScope?: unknown;
      readonly retire?: unknown;
    } & Targeted)
  | ({ readonly command: 'map.scope'; readonly client: unknown } & Targeted);
