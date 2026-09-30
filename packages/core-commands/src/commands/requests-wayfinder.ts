// SPDX-License-Identifier: AGPL-3.0-only
//
// The wayfinder commands' requests (WF-1, WF-2, WF-6), one member each of
// `CommandRequest`; split from `requests.ts` for the per-file cap. Each
// operand is `any` on its row and checked by value in its `wayfinder*.ts`
// handler, so the refusal names the operand in its own words.

import type { Envelope, Targeted } from './request-envelope.ts';

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
  | ({ readonly command: 'map.scope'; readonly client: unknown } & Targeted)
  | ({
      readonly command: 'map.chart';
      readonly title?: unknown;
      readonly destination?: unknown;
      readonly notes?: unknown;
      readonly tickets?: unknown;
      readonly fog?: unknown;
      readonly outOfScope?: unknown;
      readonly preAnswers?: unknown;
    } & Envelope)
  | ({ readonly command: 'task.set_blocking'; readonly blockedBy: unknown } & Targeted)
  | ({ readonly command: 'task.claim' } & Targeted)
  | ({
      readonly command: 'map.graduate';
      readonly patchId: unknown;
      readonly tickets: unknown;
    } & Targeted)
  | ({
      readonly command: 'task.resolve';
      readonly answer: unknown;
      readonly gist: unknown;
    } & Targeted)
  | ({ readonly command: 'task.close_out_of_scope'; readonly reason?: unknown } & Targeted);
