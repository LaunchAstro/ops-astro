// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
//
// What look parity reads from one element (look.ts), on either side. It runs
// in the page, passed to page.evaluate, so it holds no reference outside
// itself.

/** One element's measured properties, by property name. */
export type Measured = Readonly<Record<string, string>>;

/** In the page: each asked property of the element, colours as the pixel they paint. */
export function measure(input: { selector: string; props: readonly string[] }): Measured | null {
  const element = document.querySelector(input.selector);
  if (element === null) return null;
  // A transition the last style change started reads as where it began until
  // its frame comes. In the harness the dev server's sheets land after the
  // body's default style, and reduced motion gives every element a 0.01ms
  // transition of every property (1-tokens.css), so dark ink could read as
  // black. getAnimations() starts any pending transition; each is run out, as
  // a screenshot's disabled animations are. Running out a parent's starts its
  // children's on the inherited value, one level down per pass.
  for (let depth = 0; depth < 256; depth += 1) {
    const running = document
      .getAnimations()
      .filter((one) => one instanceof CSSTransition && one.playState !== 'finished');
    if (running.length === 0) break;
    for (const one of running) one.finish();
  }
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const pen = canvas.getContext('2d', { willReadFrequently: true });
  const paint = (value: string): string => {
    if (pen === null || value === '' || value === 'none') return value;
    pen.clearRect(0, 0, 1, 1);
    pen.fillStyle = '#000';
    pen.fillStyle = value;
    pen.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = pen.getImageData(0, 0, 1, 1).data;
    return `rgba(${String(r)},${String(g)},${String(b)},${String(a)})`;
  };
  const out: Record<string, string> = {};
  for (const prop of input.props) {
    if (prop.startsWith('box.')) {
      const key = prop.slice(4) as 'width' | 'height' | 'x' | 'y';
      out[prop] = String(Math.round(box[key]));
    } else if (prop === 'font-family') {
      // The face that paints: load() has proved every bundled face resolves,
      // so the fallbacks after the first never draw.
      out[prop] = (style.fontFamily.split(',')[0] ?? '').trim().replaceAll('"', '');
    } else if (prop.includes('color')) {
      out[prop] = paint(style.getPropertyValue(prop));
    } else {
      out[prop] = style.getPropertyValue(prop);
    }
  }
  return out;
}
