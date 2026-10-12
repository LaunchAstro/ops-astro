// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
//
// A reply holding one long unbroken word (a hash, an address, a run of
// characters) wraps inside a 390 px panel, drawn in Chromium under the shipped
// sheets: the transcript never scrolls sideways and the message box stays in it.

import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Transcript } from '../../packages/ui/src/surfaces/assistant/transcript.tsx';
import { drawn } from './shipped-sheets.ts';

it('a 300 character unbroken word wraps inside a 390 px panel', async () => {
  const html = renderToStaticMarkup(
    <Transcript messages={[{ id: 'm-1', role: 'ai', body: 'x'.repeat(300), cites: [] }]} />,
  );
  const seen = await drawn(
    `<div style="display:flex;width:390px;height:700px">${html}</div>`,
    { width: 390 },
    (page) =>
      page.evaluate(() => {
        const scroll = document.querySelector('.aip__scroll');
        const reply = document.querySelector('[data-message-role="ai"]');
        if (scroll === null || reply === null) return null;
        return {
          scrollWidth: scroll.scrollWidth,
          clientWidth: scroll.clientWidth,
          scrollRight: scroll.getBoundingClientRect().right,
          replyRight: reply.getBoundingClientRect().right,
        };
      }),
  );
  expect(seen).not.toBeNull();
  expect(seen?.scrollWidth).toBeLessThanOrEqual(seen?.clientWidth ?? 0);
  expect(seen?.replyRight).toBeLessThanOrEqual(seen?.scrollRight ?? 0);
}, 30_000);
