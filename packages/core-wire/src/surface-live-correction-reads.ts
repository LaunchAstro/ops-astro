// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's two reads, spread into `COMMAND_SURFACE` in `surface.ts` (kept apart
// for the line cap). Never an agent's. The decision read asks the request's
// own `run:write` (ORCH33) at the correction's party; the sidebar door's site
// read asks what a request asks, `run:write` at the task's client and
// `task:read` on the task, both inside the read.

import type { CommandDeclaration } from './surface-declaration.ts';
import { read } from './surface-builders.ts';

export const LIVE_CORRECTION_READS: readonly CommandDeclaration[] = [
  read('live_correction.read', 'run', { action: 'write' }),
  read('live_correction.locate', 'run', { action: 'write' }),
];
