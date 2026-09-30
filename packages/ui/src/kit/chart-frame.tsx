// SPDX-License-Identifier: AGPL-3.0-only
//
// What the chart primitives share around the drawing (MP-1-5): the measured
// width, one tab stop over a chart's points with its tooltip (R57), and the
// frame an axis chart draws in.

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import { trim } from './chart-numbers.ts';

/** The width of the element, kept current by the browser's resize observer. */
export function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    setWidth(Math.round(element.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const seen = entries.at(-1)?.contentRect.width;
      if (seen !== undefined) setWidth(Math.round(seen));
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, width];
}

export interface Tip {
  readonly title: string;
  readonly rows: readonly (readonly [string, string])[];
  readonly x: number;
  readonly y: number;
}

const tipLabel = (tip: Tip): string =>
  `${tip.title}: ${tip.rows.map(([label, value]) => `${label} ${value}`).join(', ')}`;

/** Where a key moves focus from `index` among `count` points, or null for a key it ignores. */
function stepFor(key: string, index: number, count: number): number | null {
  if (key === 'ArrowRight' || key === 'ArrowDown') return index + 1;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return index - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/**
 * One tab stop over a chart's points. The pointer shows a point's tip while it
 * is over it; focus shows it too, and the arrow keys, Home and End move focus
 * along the points. Hovering never moves the tab stop.
 */
export function usePoints(count: number): {
  readonly shown: number | null;
  readonly props: (index: number, tip: Tip) => Record<string, unknown>;
  readonly tipId: string;
} {
  const tipId = useId();
  const [stop, setStop] = useState(0);
  const [shown, setShown] = useState<number | null>(null);
  const nodes = useRef<(SVGElement | null)[]>([]);
  const move = (event: KeyboardEvent, index: number): void => {
    const next = stepFor(event.key, index, count);
    if (next === null) return;
    event.preventDefault();
    const target = Math.max(0, Math.min(count - 1, next));
    setStop(target);
    nodes.current[target]?.focus();
  };
  const props = (index: number, tip: Tip): Record<string, unknown> => ({
    ref: (node: SVGElement | null) => {
      nodes.current[index] = node;
    },
    role: 'img',
    'aria-label': tipLabel(tip),
    'aria-describedby': shown === index ? tipId : undefined,
    tabIndex: index === Math.min(stop, count - 1) ? 0 : -1,
    onMouseEnter: () => {
      setShown(index);
    },
    onMouseLeave: () => {
      setShown(null);
    },
    onFocus: () => {
      setStop(index);
      setShown(index);
    },
    onBlur: () => {
      setShown(null);
    },
    onKeyDown: (event: KeyboardEvent) => {
      move(event, index);
    },
  });
  return { shown, props, tipId };
}

export function Tooltip(props: { readonly id: string; readonly tip: Tip }): ReactElement {
  return (
    <div
      className="chart__tip"
      role="tooltip"
      id={props.id}
      style={{ left: `${trim(props.tip.x, 1)}px`, top: `${trim(props.tip.y, 1)}px` }}
    >
      <span className="chart__tip-title">{props.tip.title}</span>
      {props.tip.rows.map(([label, value]) => (
        <span key={label} className="chart__tip-row">
          <span>{label}</span> <span className="chart__tip-value">{value}</span>
        </span>
      ))}
    </div>
  );
}

export interface AxisChartProps {
  readonly name: string;
  readonly labels: readonly string[];
  readonly height?: number | undefined;
}

/** The frame both axis charts share: the measured holder, the named group and the tooltip. */
export function Frame(props: {
  readonly name: string;
  readonly holder: RefObject<HTMLDivElement | null>;
  readonly height: number;
  readonly width: number;
  readonly tip: ReactElement | null;
  readonly children: ReactElement;
}): ReactElement {
  return (
    <figure className="chart" role="group" aria-label={props.name}>
      <div
        className="chart__frame"
        ref={props.holder}
        style={{ height: `${String(props.height)}px` }}
      >
        {props.width > 0 && (
          <svg
            viewBox={`0 0 ${String(props.width)} ${String(props.height)}`}
            width={props.width}
            height={props.height}
          >
            {props.children}
          </svg>
        )}
        {props.tip}
      </div>
    </figure>
  );
}

/** One invisible target per label over the plot, carrying that point's tab stop and tip. */
export function HitTargets(props: {
  readonly labels: readonly string[];
  readonly y: number;
  readonly box: (index: number) => {
    readonly x: number;
    readonly width: number;
    readonly height: number;
  };
  readonly hit: (index: number) => Record<string, unknown>;
}): ReactElement {
  return (
    <>
      {props.labels.map((label, i) => {
        const box = props.box(i);
        return (
          <rect
            key={label}
            className="chart__hit"
            x={box.x}
            y={props.y}
            width={box.width}
            height={box.height}
            {...props.hit(i)}
          />
        );
      })}
    </>
  );
}
