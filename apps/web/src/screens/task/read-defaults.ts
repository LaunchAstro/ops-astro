// SPDX-License-Identifier: AGPL-3.0-only
//
// A task read from a server that predates the task page's fields draws each
// as none: no rank, no board, no steps, no time, neither mark set. The page
// reads the task through this once, at the read, so no part of it has to ask.

import type { TaskDetail } from '../../../../../packages/core-wire/src/index.ts';

type Partial<T> = { readonly [K in keyof T]?: T[K] };

/** The task as the page draws it, each missing task-page field as none. */
export function withPageDefaults<T extends TaskDetail>(task: T): T {
  const read: Partial<TaskDetail> = task;
  return {
    ...task,
    rank: read.rank ?? { number: null, score: null, calc: '' },
    adHoc: read.adHoc ?? false,
    clientAccess: read.clientAccess ?? false,
    board: read.board ?? null,
    stage: read.stage ?? null,
    clientSet: read.clientSet ?? false,
    steps: read.steps ?? [],
    time: read.time ?? null,
    agentBrief: read.agentBrief ?? null,
    pageLink: read.pageLink ?? null,
    estimateMinutes: read.estimateMinutes ?? null,
    tags: read.tags ?? [],
  };
}
