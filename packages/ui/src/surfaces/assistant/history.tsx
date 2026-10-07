// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11 CS-7.33, C36: the drawer's history. A head control shows the person's
// own past conversations, read by the caller when shown; a row opens its
// conversation as a tab and closes the list. Showing it is view state: it
// writes nothing.

import { useState, type ReactElement } from 'react';
import type { AssistantHistory } from './types.ts';
import { Icon } from '../../primitives/Icon.tsx';

/** The head's history control, and the list it shows under the tab row. */
export function useHistory(history: AssistantHistory | undefined): {
  readonly control: ReactElement | null;
  readonly list: ReactElement | null;
} {
  const [shown, setShown] = useState(false);
  if (history === undefined) return { control: null, list: null };
  const control = (
    <button
      className="aip__act"
      type="button"
      data-assistant="history"
      title="Past conversations"
      aria-label="Past conversations"
      aria-expanded={shown}
      onClick={() => {
        if (!shown) history.onShow();
        setShown(!shown);
      }}
    >
      <Icon name="clock" size="sm" />
    </button>
  );
  if (!shown) return { control, list: null };
  const open = (id: string): void => {
    setShown(false);
    history.onOpen(id);
  };
  return { control, list: <PastList history={history} open={open} /> };
}

function PastList(props: {
  readonly history: AssistantHistory;
  readonly open: (id: string) => void;
}): ReactElement {
  const { past, said } = props.history;
  let body: ReactElement;
  if (said !== null) body = <p className="aip__msg aip__msg--note">{said}</p>;
  else if (past === null) body = <p role="status">Reading your conversations…</p>;
  else if (past.length === 0)
    body = <p className="aip__msg aip__msg--note">No past conversations.</p>;
  else {
    body = (
      <ul className="aip__past">
        {past.map((one) => (
          <li key={one.id}>
            <button
              type="button"
              className="aip__chip"
              data-past={one.id}
              onClick={() => props.open(one.id)}
            >
              {one.title} · {one.lastActivityAt.slice(0, 10)}
            </button>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div data-assistant="past" aria-label="Past conversations">
      {body}
    </div>
  );
}
