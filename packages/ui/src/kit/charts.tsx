// SPDX-License-Identifier: AGPL-3.0-only
//
// Chart primitives (MP-1-5): DS-COMP-27 axis charts (line, column), DS-COMP-28
// radial charts (donut, gauge, score dial), DS-COMP-29's sparkline and
// DS-COMP-40's true-scale funnel. Hand-drawn SVG, no chart library, so the
// page carries no chart runtime.
//
// Colour comes from a tone on the element through `currentColor`, so the SVG
// never names a colour and every chart follows the theme. Text inside the SVG
// is set by the type scale's classes, never by font attributes.
//
// Axis charts measure the width they are given and redraw when it changes. A
// chart that is hidden when it mounts (a closed tab) is zero wide and draws no
// series; when it is shown the observer reports its width and it draws. Line,
// column and donut charts show each point's value on hover and on keyboard
// focus (R57): the chart is one tab stop and the arrow keys walk its points. A
// second quantity is drawn against its own labelled right-hand axis (R58),
// never divided to fit the first.
//
// The primitives live beside this file, one module per family; this module
// is their public face.

export {
  axisTicks,
  formatTick,
  formatValue,
  scoreBand,
  type ChartTone,
  type ChartUnit,
  type FunnelStep,
  type Series,
  type Slice,
} from './chart-numbers.ts';
export { LineChart } from './chart-line.tsx';
export { ColumnChart } from './chart-column.tsx';
export { DonutChart, Gauge, ScoreDial } from './chart-radial.tsx';
export { Funnel, Sparkline } from './chart-inline.tsx';
