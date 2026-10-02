// SPDX-License-Identifier: AGPL-3.0-only
//
// The Agent pane's earlier attempts (DA-07), each opened in place, and Start a
// new attempt drawn unavailable until the sidebar chat can plan one.

import type { ReactElement } from 'react';
import type { RunStory } from '../../state/agent-run.ts';
import { money } from './format.ts';

export function Attempts(props: {
  readonly stories: readonly RunStory[];
  readonly shown: RunStory;
  readonly onOpen: (lineageId: string | null) => void;
}): ReactElement | null {
  const current = props.stories.at(-1);
  const restartable =
    current !== undefined &&
    ['rejected', 'cancelled', 'dropped', 'unknown-outcome'].includes(current.state);
  if (props.stories.length < 2 && !restartable) return null;
  return (
    <div className="sb__sect" data-agent="attempts">
      <div className="sb__sh">
        <span className="sb__k">Attempts</span>
      </div>
      {props.stories.map((story) => (
        <button
          key={story.lineageId}
          className="sbact__row"
          type="button"
          aria-pressed={story.lineageId === props.shown.lineageId}
          data-attempt={story.attempt}
          onClick={() => {
            props.onOpen(story.current ? null : story.lineageId);
          }}
        >
          Attempt {story.attempt} · {story.word} · held{' '}
          {money(story.heldMinor, story.head.currency)}
          {story.actualMinor === null
            ? ''
            : ` · spent ${money(story.actualMinor, story.head.currency)}`}
        </button>
      ))}
      {restartable ? (
        <p className="sbact__meta" data-agent="start-unavailable">
          <button className="btn btn--sm" type="button" disabled data-agent="start">
            Start a new attempt
          </button>{' '}
          Start is unavailable here until the sidebar chat can accept a plan for it.
        </p>
      ) : null}
    </div>
  );
}
