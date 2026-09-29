// SPDX-License-Identifier: AGPL-3.0-only
//
// The parts of the app frame the shell places: the tab row with its sliding
// underline (MP-2-6), the app strip (MP-2-5, MP-2-9) and the freshness marker
// in the page header (MP-2-7, CS-1.1). Visual controls and their own motion
// only; which tabs, which client and which state are the application's.

import {
  useCallback,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useMark } from './mark.ts';

export interface TabEntry {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly current: boolean;
}

type Edge = 'start' | 'end';

/**
 * The section's pages as a row of tabs. The underline slides between tabs
 * over 420ms; a row wider than its column scrolls, and an edge with more tabs
 * past it fades and carries an arrow (R62).
 */
export function TabRow(props: {
  readonly label: string;
  readonly tabs: readonly TabEntry[];
}): ReactElement {
  const current = props.tabs.find((tab) => tab.current)?.id ?? null;
  const measure = useCallback(
    (item: HTMLElement) => ({ x: item.offsetLeft, w: item.offsetWidth }),
    [],
  );
  const mark = useMark(current, measure, '[aria-current="page"]');
  const [more, setMore] = useState<readonly Edge[]>([]);

  const survey = useCallback(() => {
    const scroller = mark.holder.current;
    if (scroller === null) return;
    const next: Edge[] = [];
    if (scroller.scrollLeft > 1) next.push('start');
    if (scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1) next.push('end');
    setMore((was) => (was.join() === next.join() ? was : next));
  }, [mark.holder]);

  useLayoutEffect(() => {
    const scroller = mark.holder.current;
    if (scroller === null) return undefined;
    scroller
      .querySelector('[aria-current="page"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    survey();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const watch = new ResizeObserver(survey);
    watch.observe(scroller);
    return () => {
      watch.disconnect();
    };
  }, [mark.holder, survey, current]);

  const nudge = (edge: Edge): void => {
    const scroller = mark.holder.current;
    if (scroller === null) return;
    const step = Math.max(scroller.clientWidth * 0.8, 80);
    scroller.scrollBy({ left: edge === 'start' ? -step : step, behavior: 'smooth' });
  };

  const markStyle = {
    '--tabmark-x': `${mark.box?.x ?? 0}px`,
    '--tabmark-w': `${mark.box?.w ?? 0}px`,
  } as CSSProperties;

  return (
    <nav
      className="tabbar"
      data-tabs="route"
      aria-label={props.label}
      {...(more.length === 0 ? {} : { 'data-more': more.join(' ') })}
    >
      {more.includes('start') ? (
        <button
          className="tabbar__arrow"
          type="button"
          data-edge="start"
          aria-label="Show earlier tabs"
          tabIndex={-1}
          onClick={() => {
            nudge('start');
          }}
        >
          <Chevron towards="start" />
        </button>
      ) : null}
      <div className="tabbar__scroll" ref={mark.holder} onScroll={survey}>
        {props.tabs.map((tab) => (
          <a
            key={tab.id}
            className="tabbar__t"
            href={tab.href}
            {...(tab.current ? { 'aria-current': 'page' as const } : {})}
          >
            {tab.label}
          </a>
        ))}
        <span
          className="tabmark"
          aria-hidden="true"
          hidden={mark.box === null}
          style={markStyle}
          {...(mark.placing ? { 'data-placing': '' } : {})}
        />
      </div>
      {more.includes('end') ? (
        <button
          className="tabbar__arrow"
          type="button"
          data-edge="end"
          aria-label="Show later tabs"
          tabIndex={-1}
          onClick={() => {
            nudge('end');
          }}
        >
          <Chevron towards="end" />
        </button>
      ) : null}
    </nav>
  );
}

export function Chevron(props: { readonly towards: Edge }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path
        d={props.towards === 'start' ? 'M10 3 5 8l5 5' : 'M6 3l5 5-5 5'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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
  readonly children?: ReactNode;
}): ReactElement {
  const agency = props.face === 'agency';
  return (
    <header className="appbar" data-face={props.face}>
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
        <div className="appbar__search" aria-disabled="true" title="Search is not built yet">
          <span>Search…</span>
          <kbd className="appbar__key">⌘K</kbd>
        </div>
      ) : (
        <span className="appbar__preview">Viewing as the client</span>
      )}
      {props.onFace == null ? null : <FaceSwitch face={props.face} onFace={props.onFace} />}
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
