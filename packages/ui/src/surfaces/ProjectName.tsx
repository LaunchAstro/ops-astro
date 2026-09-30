// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects board's name cell (MP-5-9, BOARDS P-30, P-32, P-33). The tick
// completes or reopens through the page's one completion transition. A plain
// click opens the task after 260ms, the window a double-click needs; a
// double-click renames in place, Enter or blur saving, Escape cancelling, a
// blank or unchanged name saving nothing. The hover box holds the timer (only
// when the page can start one), add subtask, and the door to where the work
// lives with its in-app or external mark. Modified clicks keep the link's own
// behaviour, so middle-click still opens the page.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { ProjectRow, RowActions } from '../board/projects.ts';

const OPEN_DELAY_MS = 260;

export interface ProjectNameProps {
  readonly row: ProjectRow;
  readonly href: string;
  readonly actions?: RowActions;
}

export function ProjectName(props: ProjectNameProps): ReactElement {
  const { row, href, actions } = props;
  return (
    <div className="cbd__name">
      {actions?.onTick === undefined ? null : (
        <input
          className="cbd__tick"
          type="checkbox"
          checked={row.completed}
          aria-label={row.completed ? `Reopen ${row.name}` : `Complete ${row.name}`}
          onChange={() => {
            actions.onTick?.(row, !row.completed);
          }}
        />
      )}
      <NameOrRename row={row} href={href} {...(actions === undefined ? {} : { actions })} />
      {actions === undefined ? null : <Routes row={row} href={href} actions={actions} />}
    </div>
  );
}

/** Whether `row` is the one open beside the board, by `door`. */
export const isOpened = (
  actions: RowActions | undefined,
  row: ProjectRow,
  door: 'open' | 'reply',
): boolean => actions?.opened?.id === row.id && actions.opened.door === door;

/** The name as a link, or, after a double-click, the rename input. */
function NameOrRename(props: ProjectNameProps): ReactElement {
  const { row, href, actions } = props;
  const [renaming, setRenaming] = useState(false);
  const opening = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopOpening = (): void => {
    if (opening.current !== null) clearTimeout(opening.current);
    opening.current = null;
  };
  useEffect(() => stopOpening, []);

  if (renaming) {
    return (
      <Rename
        row={row}
        onDone={(title) => {
          setRenaming(false);
          if (title !== null) actions?.onRename?.(row, title);
        }}
      />
    );
  }
  return (
    <a
      className="cbd__nm"
      href={href}
      data-panel-door={isOpened(actions, row, 'open') ? 'open' : undefined}
      onClick={(event) => {
        const onOpen = actions?.onOpen;
        if (onOpen === undefined || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        stopOpening();
        opening.current = setTimeout(() => {
          opening.current = null;
          onOpen(row);
        }, OPEN_DELAY_MS);
      }}
      onDoubleClick={(event) => {
        if (actions?.onRename === undefined) return;
        event.preventDefault();
        stopOpening();
        setRenaming(true);
      }}
    >
      {row.name}
    </a>
  );
}

/**
 * The rename input: Enter or blur hands back the new name, Escape hands back
 * null, and so does a blank or unchanged name (P-32).
 */
function Rename(props: {
  readonly row: ProjectRow;
  readonly onDone: (title: string | null) => void;
}): ReactElement {
  const [draft, setDraft] = useState(props.row.name);
  // Set once the edit is settled, so the blur that follows Enter or Escape
  // (the input leaving the page) hands back nothing a second time.
  const settled = useRef(false);
  const finish = (save: boolean): void => {
    if (settled.current) return;
    settled.current = true;
    const title = draft.trim();
    props.onDone(save && title !== '' && title !== props.row.name ? title : null);
  };
  return (
    <input
      className="input cbd__rename"
      type="text"
      value={draft}
      aria-label={`Rename ${props.row.name}`}
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- the person just asked to rename it
      autoFocus
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(true);
        if (event.key === 'Escape') finish(false);
      }}
      onBlur={() => {
        finish(true);
      }}
    />
  );
}

/** The hover box (P-33): the timer when the page can start one, add subtask, the door. */
function Routes(props: {
  readonly row: ProjectRow;
  readonly href: string;
  readonly actions: RowActions;
}): ReactElement {
  const { row, href, actions } = props;
  return (
    <span className="cbd__routes cbd__routes--pop">
      {actions.onStartTimer === undefined ? null : (
        <button
          className="cbd__route"
          type="button"
          data-route="timer"
          aria-label={`Start the timer on ${row.name}`}
          title="Start the timer"
          onClick={() => {
            actions.onStartTimer?.(row);
          }}
        >
          ▶
        </button>
      )}
      <a
        className="cbd__route"
        data-route="subtask"
        href={`${href}#add-subtask`}
        aria-label={`Add a subtask to ${row.name}`}
        title="Add a subtask"
      >
        +
      </a>
      <a
        className="cbd__route"
        data-route="door"
        data-mark="in-app"
        href={row.page ?? href}
        aria-label={`Go to the work on ${row.name}, in the app`}
        title="Go to the work (in the app)"
      >
        ↗
      </a>
    </span>
  );
}
