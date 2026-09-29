// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Shell } from '../../packages/ui/src/surfaces/Shell.tsx';

it('Sol proof, criterion MP-1-2 6: dock tabs use licensed icons instead of initials', () => {
  const html = renderToStaticMarkup(
    <Shell
      face="agency"
      rail={[]}
      here="/gallery/"
      title="Component gallery"
      dock={[{ id: 'activity', label: 'Activity', open: false }]}
      onDockTab={() => undefined}
      seated={false}
    >
      {null}
    </Shell>,
  );

  const tab = /<button[^>]*class="dock__tab"[^>]*>([\s\S]*?)<\/button>/u.exec(html)?.[1];
  expect(tab).toBeDefined();
  expect(tab).toMatch(/<svg[^>]*class="[^"]*\bicon\b/u);
  expect(tab).not.toMatch(/<span aria-hidden="true">A<\/span>/u);
});
