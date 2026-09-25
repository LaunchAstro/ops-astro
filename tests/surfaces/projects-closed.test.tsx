// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The board's create form after an authority refusal (THERMO-2 continuation,
// lead item c). `task.create` is the form's one command, so a
// `SCOPE_NOT_GRANTED` closes it through `useCommand`'s `locked`, as the comment
// box and the propose form already are: the refusal is quoted, the controls
// are disabled, and a second press is not a second request.

import { describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { mount, settle } from './mount.tsx';

function server() {
  const creates: string[] = [];
  const fetch = ((url: string | URL) => {
    const at = String(url);
    if (at.endsWith('/task/create')) {
      creates.push(at);
      return Promise.resolve(
        Response.json(
          {
            refused: true,
            code: 'SCOPE_NOT_GRANTED',
            names: ['task.create'],
            fixes: ['Ask an owner for the scope.'],
          },
          { status: 403 },
        ),
      );
    }
    return Promise.resolve(Response.json({ ok: true, tasks: [] }));
  }) as typeof globalThis.fetch;
  return { fetch, creates };
}

describe('the create form, refused on authority', () => {
  it('closes rather than asking again', async () => {
    const api = server();
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      token: 'tok',
      fetch: api.fetch,
    });
    const view = await mount(<Projects client={client} grantKey="alpha:mia" />);
    await settle();

    await view.type('#create-title', 'Wire the board to the API');
    await view.click('button[type="submit"]');
    await settle();

    expect(api.creates).toHaveLength(1);
    expect(view.find('[data-voice="input-wrong"]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect((view.find('#create-title') as HTMLInputElement).disabled).toBe(true);
    expect((view.find('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);

    await view.click('button[type="submit"]');
    await settle();
    expect(api.creates).toHaveLength(1);

    await view.unmount();
  });
});
