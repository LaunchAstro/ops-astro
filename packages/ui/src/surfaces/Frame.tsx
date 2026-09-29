// SPDX-License-Identifier: AGPL-3.0-only
//
// The parts of the app frame the shell places: the app strip (MP-2-5, MP-2-9)
// and the freshness marker in the page header (MP-2-7, CS-1.1); the tab row is
// in TabRow.tsx. Visual controls and their own motion only; which client and
// which state are the application's.

import type { ReactElement, ReactNode, Ref } from 'react';
import { Chevron } from './TabRow.tsx';

export interface StripClient {
  /** One letter. */
  readonly mark: string;
  readonly name: string;
}

export interface StripSteps {
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
}

type Face = 'agency' | 'client';

/**
 * The app strip across the top of the content column (MP-2-5): dark chrome
 * on the agency face, teal on the client face (MP-2-4). Back and Forward walk
 * the tab's history. Inside a client it carries that client's identity and
 * the face switch. Search and the timer are drawn disabled, each naming what
 * is not built yet (R29); the portal has neither. No presence is drawn until
 * live presence exists (R30).
 */
export function AppStrip(props: {
  readonly face: Face;
  readonly client: StripClient | null;
  readonly steps?: StripSteps;
  /** The switch, inside a client only; pressing the face already on does nothing. */
  readonly onFace?: ((face: Face) => void) | null;
  /** Opens search (C1); without it the agency face draws search disabled (R29). */
  readonly onSearch?: (() => void) | null;
  /** Where focus returns when search closes. */
  readonly searchRef?: Ref<HTMLButtonElement>;
  readonly children?: ReactNode;
}): ReactElement {
  const agency = props.face === 'agency';
  return (
    <header className="appbar" data-face={props.face}>
      <Steps steps={props.steps} />
      {props.client === null ? null : (
        <div className="clienthdr">
          <span className="clienthdr__mark" aria-hidden="true">
            {props.client.mark}
          </span>
          <span className="clienthdr__name">{props.client.name}</span>
          <span className="clienthdr__tag">{agency ? 'Agency view' : 'Client portal'}</span>
        </div>
      )}
      {agency ? (
        <StripSearch onSearch={props.onSearch} searchRef={props.searchRef} />
      ) : (
        <span className="appbar__preview">Viewing as the client</span>
      )}
      {props.onFace ? <FaceSwitch face={props.face} onFace={props.onFace} /> : null}
      {agency ? (
        <button
          className="appbar__timer"
          type="button"
          disabled
          title="Time tracking is not built yet"
        >
          <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
            <path d="M5 3.5v9l7-4.5z" fill="currentColor" />
          </svg>
          <span className="appbar__label">Start timer</span>
        </button>
      ) : null}
      {props.children}
    </header>
  );
}

/** Back and Forward through the tab's history; both disabled without one. */
function Steps(props: { readonly steps: StripSteps | undefined }): ReactElement {
  return (
    <>
      <button
        className="appbar__step"
        type="button"
        aria-label="Back"
        disabled={props.steps?.canBack !== true}
        onClick={props.steps?.onBack}
      >
        <Chevron towards="start" />
      </button>
      <button
        className="appbar__step"
        type="button"
        aria-label="Forward"
        disabled={props.steps?.canForward !== true}
        onClick={props.steps?.onForward}
      >
        <Chevron towards="end" />
      </button>
    </>
  );
}

/** The agency face's search box, or the same box disabled without `onSearch` (R29). */
function StripSearch(props: {
  readonly onSearch: (() => void) | null | undefined;
  readonly searchRef: Ref<HTMLButtonElement> | undefined;
}): ReactElement {
  if (!props.onSearch) {
    return (
      <div className="appbar__search" aria-disabled="true" title="Search is not built yet">
        <span>Search…</span>
        <kbd className="appbar__key">⌘K</kbd>
      </div>
    );
  }
  return (
    <button
      className="appbar__search"
      type="button"
      ref={props.searchRef}
      aria-keyshortcuts="Meta+K Control+K"
      onClick={props.onSearch}
    >
      <span>Search…</span>
      <kbd className="appbar__key">⌘K</kbd>
    </button>
  );
}

function FaceSwitch(props: {
  readonly face: Face;
  readonly onFace: (face: Face) => void;
}): ReactElement {
  return (
    <div className="facesw" role="group" aria-label="View as">
      {(['agency', 'client'] as const).map((face) => (
        <button
          key={face}
          type="button"
          data-face={face}
          aria-pressed={props.face === face}
          onClick={() => {
            if (face !== props.face) props.onFace(face);
          }}
        >
          {face === 'agency' ? 'Agency' : 'Client'}
        </button>
      ))}
    </div>
  );
}

/** The five things the header can say about how current the page is (CS-1.1). */
export const FRESHNESS_STATES = [
  'live',
  'catching-up',
  'offline',
  'source-behind',
  'frozen',
] as const;
export type FreshnessState = (typeof FRESHNESS_STATES)[number];

const saying = (state: FreshnessState, at: string | undefined): string => {
  switch (state) {
    case 'live':
      return at === undefined ? 'Live' : `Live · ${at}`;
    case 'catching-up':
      return 'Catching up';
    case 'offline':
      return 'Offline';
    case 'source-behind':
      return at === undefined ? 'Source behind' : `Source behind · data to ${at}`;
    case 'frozen':
      return at === undefined ? 'Frozen' : `Frozen ${at}`;
  }
};

/**
 * The freshness marker: an indicator, never a control. There is no sync
 * button; the page keeps itself current and the browser's reload remains.
 */
export function Freshness(props: {
  readonly state: FreshnessState;
  /** The data's age or its "data to" time, already in words. */
  readonly at?: string;
}): ReactElement {
  return (
    <span className="marker fresh" role="status" data-freshness={props.state}>
      {saying(props.state, props.at)}
    </span>
  );
}
