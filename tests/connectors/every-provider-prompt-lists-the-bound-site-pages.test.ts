// SPDX-License-Identifier: AGPL-3.0-only
//
// #1988: the `page` field carries the business's bound site pages the caller
// may ask a correction on (`conversation-context.ts`), and every provider's
// system message lists them, each by repository and page address, with the
// site change block and the instruction to play the plan back in words first
// and to name only a listed page. Given none, the model is told no site page
// is set up. The list is catalogue data: no page content, no task id.

import { describe, expect, it } from 'vitest';
import {
  chatgptPlanAdapter,
  ollamaAdapter,
  openrouterRequest,
  promptSites,
} from '../../packages/core-connectors/src/index.ts';

const SITES = [
  { repository: 'agency-astro/site', page: 'https://agencyastro.com/about' },
  { repository: 'agency-astro/site', page: 'https://agencyastro.com/contact' },
];

/** The system message each provider sends for these fields. */
function systems(fields: Readonly<Record<string, string>>): readonly string[] {
  const chats = [ollamaAdapter(fields).body, openrouterRequest(fields).body].map((body) => {
    const { messages } = JSON.parse(body) as { messages: { role: string; content: string }[] };
    return messages.find((message) => message.role === 'system')?.content ?? '';
  });
  const plan = JSON.parse(chatgptPlanAdapter(fields).body) as { instructions: string };
  return [...chats, plan.instructions];
}

// eslint-disable-next-line max-lines-per-function -- each provider's prompt case, on one system message
describe('every provider’s prompt and the bound site pages', () => {
  it('lists each bound page by repository and address, and says to play the plan back before the block', () => {
    const page = JSON.stringify({ sites: SITES });
    for (const system of systems({
      page,
      message: 'Change Brisbane to Townsville on the About page',
    })) {
      expect(system).toContain('- agency-astro/site: https://agencyastro.com/about');
      expect(system).toContain('- agency-astro/site: https://agencyastro.com/contact');
      expect(system).toContain('"action":"site_change"');
      expect(system).toContain(
        'say back in words the site and its repository, the page address, the text before and after, who it is for (internal) and a rough time',
      );
      expect(system).toContain('Use only a page from this list');
    }
  });

  it('a chat on a task keeps its open-task words beside the pages', () => {
    const page = JSON.stringify({ task: 'T-1', title: 'Spring brief', sites: SITES });
    for (const system of systems({ page, message: 'Fix the About page' })) {
      expect(system).toContain('The person has this task open: "Spring brief".');
      expect(system).toContain('- agency-astro/site: https://agencyastro.com/about');
      expect(system).not.toContain('T-1');
    }
  });

  it('given no pages, the model is told no site page is set up and offered no site change', () => {
    for (const fields of [
      { message: 'Fix the About page' },
      { page: JSON.stringify({ created: true }), message: 'x' },
    ]) {
      for (const system of systems(fields)) {
        expect(system).toContain(
          'No site page is set up for changes here, so if the person asks for one, say the page is not set up.',
        );
        expect(system).not.toContain('site_change');
      }
    }
  });

  it('the sites read takes only whole entries, and anything else as none', () => {
    expect(promptSites(JSON.stringify({ sites: SITES }))).toStrictEqual(SITES);
    for (const odd of [
      undefined,
      '',
      '{',
      '{"sites":"x"}',
      '{"sites":[{"repository":"a/b"}]}',
      '{"sites":[{"repository":"a/b","page":"https://x","path":"src/x.astro"}]}',
      '{"sites":[{"repository":1,"page":"https://x"}]}',
    ]) {
      expect(promptSites(odd)).toStrictEqual([]);
    }
  });
});
