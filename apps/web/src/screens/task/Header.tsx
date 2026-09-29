// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's record header (MP-4-1, DS-TASK-11): the crumb, the title and
// the run line.
//
// **The crumb is the record's.** "Projects →" goes back to the board, then the
// task's board as `task.read` names it: its title, "No board", or a board the
// reader may not open, which the server withholds rather than this screen
// hiding. The category after it waits on a named section (no board section has
// a name yet).
//
// **Copy link copies the canonical address** (`/task/<key>` on this origin,
// the ruled form, never the mockup's `?task=`), and the tick shows only once
// the clipboard said yes, for 1.2 s. A clipboard that refuses, or none at all,
// is said in words beside the control with the address to copy by hand.
//
// **The run line has three shapes** worked out from the attempts on the
// task's proposals: running, finished, or no agent at all.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Spill } from '@launchastro/ui';
import type {
  BoardCrumb,
  InternalTaskDetail,
  ProposalView,
} from '../../../../../packages/core-wire/src/index.ts';
import { pathTo } from '../../routes.ts';
import { drawTaskState } from '../../views/task-state.ts';
import { titleOf } from '../../views/task-title.ts';

/** How long the tick stays after a copy that worked (TP-05). */
export const COPIED_FOR_MS = 1200;

export function TaskHeader(props: { readonly task: InternalTaskDetail }): ReactElement {
  const { task } = props;
  const run = runLineOf(task.proposals);
  return (
    <header className="tpr">
      <nav className="tpr__crumb" aria-label="Where this task sits">
        <a className="sb__addr" data-crumb="projects" href={pathTo('agency:projects-board')}>
          Projects →
        </a>
        <span data-crumb="board">{boardWords(task.board)}</span>
        <span aria-hidden="true">·</span>
        <span className="sbact__meta" data-crumb="key">
          {task.key}
        </span>
        <span data-crumb="state">
          <Spill state={drawTaskState(task.state)} />
        </span>
        <CopyAddress path={pathTo('agency:task-detail', { key: task.key })} />
      </nav>
      <h2 className="tpr__title">{titleOf(task.title)}</h2>
      {run === null ? null : (
        <p className="card__sub" data-run={run.shape}>
          {run.words}
        </p>
      )}
      <div className="card__sub">
        Revision {task.revision} ·{' '}
        {task.completedAt === null ? 'not completed' : `completed ${task.completedAt}`}
      </div>
    </header>
  );
}

function boardWords(board: BoardCrumb | null): string {
  if (board === null) return 'No board';
  if (!board.readable) return 'A board you cannot open';
  return titleOf(board.title);
}

export type RunShape = 'running' | 'finished' | 'none';

/**
 * The run line: the agent attempts on every proposal, counted. Any attempt
 * still reserved or dispatched is a run in progress; otherwise every attempt
 * has ended, however it ended. An answer that did not carry the proposals
 * draws no run line, as the proposals view says "not carried" rather than
 * "none" (`views/proposals.tsx`): no attempts read is not no attempts made.
 */
export function runLineOf(
  proposals: readonly ProposalView[] | undefined,
): { readonly shape: RunShape; readonly words: string } | null {
  if (proposals === undefined) return null;
  const attempts = proposals
    .flatMap((proposal) => proposal.reservations)
    .flatMap((reservation) => (reservation.attempt === null ? [] : [reservation.attempt]));
  if (attempts.length === 0) return { shape: 'none', words: 'No agent has worked on this task' };
  const running = attempts.some(
    (attempt) => attempt.state === 'reserved' || attempt.state === 'dispatched',
  );
  const shape = running ? 'running' : 'finished';
  return { shape, words: `Attempt ${attempts.length} · ${shape}` };
}

/**
 * The copy and its outcome. `copied` is true only after the clipboard said
 * yes, and for `COPIED_FOR_MS`; `failed` is true after it said no, or when
 * there is no clipboard to ask.
 */
function useCopy(text: string): {
  readonly copied: boolean;
  readonly failed: boolean;
  readonly copy: () => Promise<void>;
} {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const settle = (worked: boolean): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setCopied(worked);
    setFailed(!worked);
    if (!worked) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setCopied(false);
    }, COPIED_FOR_MS);
  };

  const copy = async (): Promise<void> => {
    // Absent in an insecure context and in some embedded browsers: that is a
    // failed copy, said as one, not a tick for nothing.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      settle(false);
      return;
    }
    try {
      await clipboard.writeText(text);
    } catch {
      settle(false);
      return;
    }
    settle(true);
  };

  return { copied, failed, copy };
}

/** Copy link: the tick only when the copy worked, and words when it did not. */
function CopyAddress(props: { readonly path: string }): ReactElement {
  const address = `${window.location.origin}${props.path}`;
  const { copied, failed, copy } = useCopy(address);
  return (
    <>
      <button
        className="btn"
        type="button"
        data-copy="address"
        data-copied={copied ? 'yes' : 'no'}
        onClick={() => {
          void copy();
        }}
      >
        {copied ? 'Copied ✓' : 'Copy link'}
      </button>
      {failed ? (
        <span className="field__error" role="alert" data-copy="failed">
          The link could not be copied. Copy it by hand: {address}
        </span>
      ) : null}
    </>
  );
}
