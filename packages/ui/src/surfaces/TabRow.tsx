// SPDX-License-Identifier: AGPL-3.0-only
//
// The tab row with its sliding underline (MP-2-6), which the shell places
// under the app strip. Visual controls and their own motion only; which tabs
// there are is the application's.

import {
  useCallback,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type ReactElement,
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
  const { more, survey, nudge } = useOverflow(mark.holder, current);
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
      {more.includes('start') ? <EdgeArrow edge="start" onNudge={nudge} /> : null}
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
      {more.includes('end') ? <EdgeArrow edge="end" onNudge={nudge} /> : null}
    </nav>
  );
}

/**
 * Which edges of the row have tabs past them, surveyed on load, on a change of
 * tab, on scroll and on resize; the current tab is scrolled into view first.
 */
function useOverflow(
  holder: React.RefObject<HTMLDivElement | null>,
  current: string | null,
): {
  readonly more: readonly Edge[];
  readonly survey: () => void;
  readonly nudge: (edge: Edge) => void;
} {
  const [more, setMore] = useState<readonly Edge[]>([]);
  const survey = useCallback(() => {
    const scroller = holder.current;
    if (scroller === null) return;
    const next: Edge[] = [];
    if (scroller.scrollLeft > 1) next.push('start');
    if (scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1) next.push('end');
    setMore((was) => (was.join() === next.join() ? was : next));
  }, [holder]);

  useLayoutEffect(() => {
    const scroller = holder.current;
    if (scroller === null) return;
    scroller
      .querySelector('[aria-current="page"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    survey();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(survey);
    watch.observe(scroller);
    return () => {
      watch.disconnect();
    };
  }, [holder, survey, current]);

  const nudge = (edge: Edge): void => {
    const scroller = holder.current;
    if (scroller === null) return;
    const step = Math.max(scroller.clientWidth * 0.8, 80);
    scroller.scrollBy({ left: edge === 'start' ? -step : step, behavior: 'smooth' });
  };
  return { more, survey, nudge };
}

function EdgeArrow(props: {
  readonly edge: Edge;
  readonly onNudge: (edge: Edge) => void;
}): ReactElement {
  return (
    <button
      className="tabbar__arrow"
      type="button"
      data-edge={props.edge}
      aria-label={props.edge === 'start' ? 'Show earlier tabs' : 'Show later tabs'}
      tabIndex={-1}
      onClick={() => {
        props.onNudge(props.edge);
      }}
    >
      <Chevron towards={props.edge} />
    </button>
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
