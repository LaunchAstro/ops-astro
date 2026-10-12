// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react';
/**
 * The box a row's words are edited in, showing `body` and handing each
 * keystroke up. It hands back the new words, or null when nothing is to be
 * stored: Esc, words the same as the stored ones (`saved`), or an emptied box.
 */
export function EditBox(props: {
  readonly saved: string;
  readonly body: string;
  readonly busy: boolean;
  readonly onText: (body: string) => void;
  readonly onDone: (next: string | null) => void;
}): ReactElement {
  // Esc or a commit ends the edit once; the blur that can follow the box
  // leaving the page must not end it a second time. A refusal reopens it.
  const ended = useRef(false);
  useEffect(() => {
    if (!props.busy) ended.current = false;
  }, [props.busy]);
  const end = (next: string | null): void => {
    if (ended.current || props.busy) return;
    ended.current = true;
    props.onDone(next === null || next.trim() === '' || next === props.saved ? null : next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      end(null);
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      end(props.body);
    }
  };
  return (
    <textarea
      className="input"
      aria-label="Edit your message"
      data-comment-edit=""
      rows={3}
      readOnly={props.busy}
      aria-busy={props.busy}
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- the pencil was pressed to write here
      autoFocus
      value={props.body}
      onKeyDown={onKeyDown}
      onBlur={() => {
        end(props.body);
      }}
      onChange={(event) => {
        props.onText(event.target.value);
      }}
    />
  );
}
