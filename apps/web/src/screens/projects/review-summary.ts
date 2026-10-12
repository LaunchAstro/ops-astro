// SPDX-License-Identifier: AGPL-3.0-only
import { runStories, scopeStamp, shippedOf, stagedOf } from '@launchastro/ui';
import type { InternalTaskDetail } from '../../../../../packages/core-wire/src/index.ts';

export function reviewSummary(task: InternalTaskDetail) {
  const waiting = runStories(task.proposals).filter((story) => story.gate.kind === 'armed');
  const staged = waiting.some(
    (story) => stagedOf(story.head) !== null && shippedOf(story.head) === null,
  );
  const proposed =
    waiting.length > 0 &&
    waiting.every((story) => story.head.startedAt === null && stagedOf(story.head) === null);
  const skills = [
    ...new Set(
      waiting.flatMap((story) =>
        (story.head.pins ?? []).flatMap((pin) =>
          pin.kind === 'bootstrap_file' && pin.path !== null ? [pin.path] : [],
        ),
      ),
    ),
  ];
  return {
    kind: staged ? 'staged' : proposed ? 'proposed' : 'other',
    shows: task.description ?? '',
    action: waiting.map((story) => story.head.purpose.replaceAll('_', ' ')).join('\n'),
    needs:
      waiting.length === 0
        ? 'This task no longer has an open decision. Open its plan for the latest state.'
        : 'Review the exact version and approve it, or discuss what needs to change.',
    skills,
    clearances: [
      ...new Set(
        task.proposals
          .filter((lineage) => waiting.some((story) => story.lineageId === lineage.lineageId))
          .flatMap((lineage) => {
            const stamp = scopeStamp(lineage);
            return stamp.kind === 'agent' ? [stamp.clearance] : [];
          }),
      ),
    ],
    canReview: waiting.length > 0,
  } as const;
}
