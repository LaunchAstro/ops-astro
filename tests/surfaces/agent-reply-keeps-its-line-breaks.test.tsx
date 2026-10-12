// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
//
// An agent's reply is read as it was written: its line breaks and indentation
// survive in the transcript, drawn in Chromium under the shipped sheets. The
// citations and the plan card under a reply keep their own layout.

import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Transcript } from '../../packages/ui/src/surfaces/assistant/transcript.tsx';
import type {
  AssistantMessage,
  AssistantPlan,
} from '../../packages/ui/src/surfaces/assistant/types.ts';
import { drawn } from './shipped-sheets.ts';

const BODY = 'if ready:\n    publish()\nfinish()';

const PLAN: AssistantPlan = {
  version: 1,
  text: 'Draft the post',
  steps: [{ title: 'Draft', after: [] }],
  entryPath: 'plan.md',
  paths: [],
  ceilingMinor: 500,
  spendMinor: 0,
  currency: 'AUD',
  state: 'offered',
  replacedBy: null,
  refusal: null,
  task: { label: 'T-1', href: '/tasks/T-1' },
};

const MESSAGES: readonly AssistantMessage[] = [
  { id: 'm-1', role: 'ai', body: BODY, cites: [{ label: 'Brief', href: '/records/brief' }] },
  { id: 'm-2', role: 'plan', body: 'Here is the plan.', cites: [], plan: PLAN },
];

it('an agent reply keeps its line breaks and indentation', async () => {
  const html = renderToStaticMarkup(<Transcript messages={MESSAGES} />);
  const seen = await drawn(
    `<div style="display:flex;width:390px;height:700px">${html}</div>`,
    {},
    (page) =>
      page.evaluate(() => {
        const reply = document.querySelector<HTMLElement>('[data-message-role="ai"]');
        const cites = document.querySelector('.aip__cites');
        const plan = document.querySelector('.aip__plan');
        return {
          reply: reply?.innerText ?? null,
          cites: cites === null ? null : getComputedStyle(cites).whiteSpace,
          plan: plan === null ? null : getComputedStyle(plan).whiteSpace,
        };
      }),
  );
  expect(seen.reply).toContain(BODY);
  expect(seen.cites).toBe('normal');
  expect(seen.plan).toBe('normal');
}, 30_000);
