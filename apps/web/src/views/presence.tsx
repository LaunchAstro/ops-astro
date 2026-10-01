// SPDX-License-Identifier: AGPL-3.0-only
//
// C2's two drawings: who else is on this page, in the app strip (CS-7.1,
// SH-15), and who else is on this task and what they are changing (CS-7.36).
// Both draw only what the presence book answered through the tab's seat; the
// strip is never drawn from the team list. A page shows its viewers to the
// strip through `useShowOnPage`, and a page with no record shows nobody: there
// is no business-wide topic to read. The strip's avatars are plain circles
// until the kit's AvatarStack lands.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { AvatarStack } from '@launchastro/ui';
import type { PresenceView } from '../data/presence.ts';

const NOBODY: readonly PresenceView[] = [];
const Seen = createContext<readonly PresenceView[]>(NOBODY);
const Show = createContext<((seen: readonly PresenceView[]) => void) | null>(null);

export function PagePresenceProvider(props: { readonly children: ReactNode }): ReactElement {
  const [seen, show] = useState<readonly PresenceView[]>(NOBODY);
  return (
    <Show.Provider value={show}>
      <Seen.Provider value={seen}>{props.children}</Seen.Provider>
    </Show.Provider>
  );
}

/** Put this page's viewers in the strip while the page is open. */
export function useShowOnPage(seen: readonly PresenceView[]): void {
  const show = useContext(Show);
  useEffect(() => {
    show?.(seen);
  }, [show, seen]);
  useEffect(() => () => show?.(NOBODY), [show]);
}

export function StripPresence(): ReactElement | null {
  const seen = useContext(Seen);
  if (seen.length === 0) return null;
  return (
    <span className="presence-strip" data-presence="page" aria-label="Also on this page">
      {/* The kit's stack (DS-PRIM-16): each face names its person, and the
          reader is never in it, so no face is marked as here. */}
      <AvatarStack people={seen.map((person) => ({ name: person.name }))} />
    </span>
  );
}

const LABELS: Readonly<Record<string, string>> = { title: 'Title', due: 'Due date' };
const labelOf = (field: string): string => LABELS[field] ?? field.replaceAll('_', ' ');

export function TaskPresence(props: {
  readonly seen: readonly PresenceView[];
}): ReactElement | null {
  if (props.seen.length === 0) return null;
  return (
    <ul className="presence-task" data-presence="task" aria-live="polite">
      {props.seen.map((person) => (
        <li key={person.personId}>
          {person.state === 'changing' && person.field !== null
            ? `${person.name} is editing ${labelOf(person.field)}`
            : `${person.name} is viewing`}
        </li>
      ))}
    </ul>
  );
}
