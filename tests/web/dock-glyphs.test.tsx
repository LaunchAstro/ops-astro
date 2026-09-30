// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-3-1 and MP-2-3 on the kit's icon set (MP-1-2): every control on the
// dock's head, Close all and the rail's fold draws the glyph the mockup names
// for it (DOCK DK-06, DK-09, DK-11 to DK-13; SHELL SH-7), from the licensed
// set, never a typed character standing in for one.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Icon, type GlyphName } from '../../packages/ui/src/primitives/Icon.tsx';
import { Dock, type DockProps } from '../../packages/ui/src/surfaces/Dock.tsx';
import { Shell } from '../../packages/ui/src/surfaces/Shell.tsx';

const glyph = (name: GlyphName): string => renderToStaticMarkup(<Icon name={name} />);

/** The inner markup of the element carrying `attr`, up to its closing tag. */
function inside(html: string, tag: 'a' | 'button', attr: string): string {
  const at = html.indexOf(attr);
  expect(at, attr).toBeGreaterThan(-1);
  const open = html.lastIndexOf(`<${tag}`, at);
  return html.slice(html.indexOf('>', at) + 1, html.indexOf(`</${tag}>`, open));
}

const noop = (): void => undefined;
const dock = (icon?: GlyphName): DockProps => ({
  tabs: [{ id: 'todos', label: 'Projects', count: null, open: true }],
  panels: [
    {
      id: 'todos',
      label: 'Projects',
      ariaLabel: 'Projects',
      door: '/projects/',
      ...(icon === undefined ? {} : { icon }),
      canBack: false,
      canForward: false,
      body: null,
    },
  ],
  onTab: noop,
  onClose: noop,
  onCloseAll: noop,
  onBack: noop,
  onForward: noop,
  onDoor: noop,
});

describe('MP-3-1 head glyphs', () => {
  it("draws the mockup's glyph on each head control and on Close all", () => {
    const html = renderToStaticMarkup(<Dock {...dock('briefcase')} />);
    expect(inside(html, 'button', 'data-act="back"')).toBe(glyph('angle-small-left'));
    expect(inside(html, 'button', 'data-act="forward"')).toBe(glyph('angle-small-right'));
    expect(inside(html, 'button', 'data-act="close"')).toBe(glyph('cross-small'));
    expect(inside(html, 'button', 'aria-label="Close all panels"')).toBe(glyph('cross-small'));
  });

  it("the door draws its destination's own glyph, the in-app arrow when it names none", () => {
    const own = renderToStaticMarkup(<Dock {...dock('briefcase')} />);
    expect(inside(own, 'a', 'data-act="door"')).toBe(glyph('briefcase'));
    const none = renderToStaticMarkup(<Dock {...dock()} />);
    expect(inside(none, 'a', 'data-act="door"')).toBe(glyph('arrow-small-right'));
  });
});

describe('MP-2-3 fold glyph', () => {
  it('the fold draws angle-double-left open and angle-double-right folded', () => {
    const shell = (collapsed: boolean): string =>
      renderToStaticMarkup(
        <Shell
          face="agency"
          rail={[]}
          here="/"
          title="Board"
          dock={null}
          railCollapsed={collapsed}
          onRailFold={noop}
        >
          {null}
        </Shell>,
      );
    expect(inside(shell(false), 'button', 'class="railfold"')).toBe(glyph('angle-double-left'));
    expect(inside(shell(true), 'button', 'class="railfold"')).toBe(glyph('angle-double-right'));
  });
});
