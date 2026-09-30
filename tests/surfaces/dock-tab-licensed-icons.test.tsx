// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Shell } from '../../packages/ui/src/surfaces/Shell.tsx';

it('MP-1-2 dock tabs use licensed icons instead of initials', () => {
  const html = renderToStaticMarkup(
    <Shell
      face="agency"
      rail={[]}
      here="/gallery/"
      title="Component gallery"
      dock={{
        tabs: [{ id: 'activity', label: 'Activity', count: null, open: false }],
        panels: [],
        onTab: () => undefined,
        onClose: () => undefined,
        onCloseAll: () => undefined,
        onBack: () => undefined,
        onForward: () => undefined,
        onDoor: () => undefined,
      }}
    >
      {null}
    </Shell>,
  );

  const tab = /<button[^>]*class="dock__tab"[^>]*>([\s\S]*?)<\/button>/u.exec(html)?.[1];
  expect(tab).toBeDefined();
  expect(tab).toMatch(/<svg[^>]*class="[^"]*\bicon\b/u);
  expect(tab).not.toMatch(/<span aria-hidden="true">A<\/span>/u);
});
