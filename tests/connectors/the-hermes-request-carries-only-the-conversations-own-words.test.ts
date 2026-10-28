// SPDX-License-Identifier: AGPL-3.0-only
//
// #2270: Hermes Agent hears only the conversation's own words. Its request is
// the earlier turns and the typed message, streamed, and nothing else: no
// instructions, and no page or task text, which other people may have written.

import { describe, expect, it } from 'vitest';
import {
  HERMES_MODEL,
  HERMES_PATH,
  hermesRequest,
} from '../../packages/core-connectors/src/index.ts';

const PAGE = JSON.stringify({
  task: '5c0ffee0-0000-4000-8000-000000000001',
  title: 'Spring brief',
});
const EARLIER = JSON.stringify([
  { role: 'person', body: 'Find me three venues.' },
  { role: 'agent', body: 'Here are three.' },
]);

describe('the Hermes request', () => {
  it('is the earlier turns and the typed message, streamed, to the one path', () => {
    const built = hermesRequest({ page: PAGE, earlier: EARLIER, message: 'Book the second.' });
    expect(built.path).toBe(HERMES_PATH);
    expect(built.method).toBe('POST');
    expect(built.body).toBe(
      JSON.stringify({
        model: HERMES_MODEL,
        messages: [
          { role: 'user', content: 'Find me three venues.' },
          { role: 'assistant', content: 'Here are three.' },
          { role: 'user', content: 'Book the second.' },
        ],
        stream: true,
      }),
    );
  });

  it('carries no instructions and no page text', () => {
    const { body } = hermesRequest({ page: PAGE, message: 'Anything due?' });
    const { messages } = JSON.parse(body) as { messages: { role: string }[] };
    expect(messages.map((message) => message.role)).toStrictEqual(['user']);
    expect(body).not.toContain('Spring brief');
    expect(body).not.toContain('task');
  });
});
