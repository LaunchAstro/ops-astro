// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom

import { act } from 'react';
import { expect, it } from 'vitest';
import { TeamScreen } from '../../apps/web/src/screens/Team.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from './mount.tsx';

const json = (value: unknown): Response => Response.json(value);

async function away(page: Mounted, reason: string): Promise<void> {
  await page.click('.tmc__me button.tmc__set');
  await page.type('.tmc__me input[name="reason"]', reason);
  await page.click('.tmc__me button[type="submit"]');
  await settle();
}

/* eslint-disable max-lines-per-function, require-await -- Sol's proof, kept as written */
// Sol's proof on #1369 (round 2), retitled by what it proves; its body is Sol's.
it('the latest availability survives an older write committed while its response is still pending', async () => {
  let stored: { state: string; reason: string } | null = null;
  const committed: string[] = [];
  let commitOlder: (() => void) | undefined;
  let answerLatest: (() => void) | undefined;
  let saves = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/team/list')) {
      return json({
        ok: true,
        you: 'p-me',
        people: [{ personId: 'p-me', name: 'Ada', availability: stored }],
      });
    }
    if (!String(input).endsWith('/account/availability')) return json({ ok: true });
    const body = JSON.parse(String(init?.body)) as { state: string; reason: string };
    saves += 1;
    if (saves === 1) {
      return new Promise<Response>((resolve) => {
        commitOlder = () => {
          stored = body;
          committed.push(body.reason);
          resolve(json({ availability: body }));
        };
      });
    }
    stored = body;
    committed.push(body.reason);
    if (saves === 2) {
      return new Promise<Response>((resolve) => {
        answerLatest = () => resolve(json({ availability: body }));
      });
    }
    return json({ availability: body });
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const page = await mount(<TeamScreen client={client} grantKey="alpha:ada:0" />);
  try {
    await settle();
    await away(page, 'Older choice');
    expect(commitOlder).toBeTypeOf('function');
    await page.render(<div>Another page</div>);
    await page.render(<TeamScreen client={client} grantKey="alpha:ada:0" />);
    await settle();
    await away(page, 'Latest choice');
    expect(answerLatest).toBeTypeOf('function');
    expect(committed).toEqual(['Latest choice']);
    await act(async () => {
      commitOlder?.();
    });
    await settle();
    expect(committed.slice(0, 2)).toEqual(['Latest choice', 'Older choice']);
    await act(async () => {
      answerLatest?.();
    });
    await settle();
    await page.render(<div>Another page</div>);
    await page.render(<TeamScreen client={client} grantKey="alpha:ada:0" />);
    await settle();
    expect(page.find('.tmc__me')?.textContent).toContain('Latest choice');
    // @ts-expect-error -- TypeScript narrows the value the server stub assigns to null here.
    expect(stored?.reason).toBe('Latest choice');
  } finally {
    commitOlder?.();
    answerLatest?.();
    await settle();
    await page.unmount();
  }
});
/* eslint-enable max-lines-per-function, require-await */
