// SPDX-License-Identifier: AGPL-3.0-only
//
// A screen reader hears who said each message in the assistant's transcript:
// the person's question, the agent's answer and a system note carry their
// speaker in words, read from Chromium's accessibility tree under the shipped
// sheets, not only in classes a sighted reader sees as colour and position.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Transcript } from '../../packages/ui/src/surfaces/assistant/transcript.tsx';
import type { AssistantMessage } from '../../packages/ui/src/surfaces/assistant/types.ts';
import { launchChromium } from '../support/chromium.ts';

const repo = (path: string): string => join(process.cwd(), path);

const sheets = (): string =>
  [
    ...readFileSync(repo('packages/ui/src/index.ts'), 'utf8').matchAll(
      /^import '\.\/(styles\/[\w-]+\.css)';$/gmu,
    ),
  ]
    .map((match) => readFileSync(repo(`packages/ui/src/${match[1] ?? ''}`), 'utf8'))
    .join('\n');

const said = (id: string, role: AssistantMessage['role']): AssistantMessage => ({
  id,
  role,
  body: 'Booking form is live',
  cites: [],
});

it('each message in the transcript is read out with its speaker', async () => {
  const html = renderToStaticMarkup(
    createElement(Transcript, {
      messages: [said('m1', 'user'), said('m2', 'ai'), said('m3', 'note'), said('m4', 'failed')],
    }),
  );
  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await page.setContent(`<style>${sheets()}</style>${html}`);
    const heard = await page.getByRole('log', { name: 'Conversation' }).ariaSnapshot();
    expect(heard.match(/Booking form is live/gu)).toHaveLength(4);
    expect(heard).toMatch(
      /You: ?Booking form is live.*Agent: ?Booking form is live.*Note: ?Booking form is live.*Problem: ?Booking form is live/su,
    );
  } finally {
    await browser.close();
  }
}, 30_000);
