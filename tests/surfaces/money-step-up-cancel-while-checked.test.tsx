// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable require-await, max-lines-per-function, unicorn/consistent-function-scoping -- Sol's proof, kept as written */

import { act, useState } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { StepUpPrompt } from '../../apps/web/src/views/step-up-prompt.tsx';
import { StepUpContext, useMoneyCommand } from '../../apps/web/src/records/use-money-command.ts';
import { mount } from './mount.tsx';

function clientWith(send: (body: Record<string, unknown>) => Response): OperationsClient {
  return new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    newOperationId: () => crypto.randomUUID(),
    fetch: async (_url, init) => send(JSON.parse(String(init?.body)) as Record<string, unknown>),
  });
}

// Sol OW-099.1 criterion 5, retitled by what it proves; its body is Sol's.
it('cancelling a step-up while its code is checked prevents the held money write', async () => {
  const sent: Record<string, unknown>[] = [];
  const oldClient = clientWith((body) => {
    sent.push(body);
    return Response.json(
      { refused: true, code: 'STEP_UP_REQUIRED', names: [], fixes: [] },
      { status: 403 },
    );
  });
  const newClient = clientWith((body) => {
    sent.push(body);
    return Response.json({ recordId: null, revision: null, detail: {} });
  });
  let finish = () => {};
  const verified = new Promise<void>((resolve) => {
    finish = resolve;
  });
  function MoneyForm({ client }: { readonly client: OperationsClient }) {
    const command = useMoneyCommand(client);
    return (
      <>
        <button
          data-send=""
          onClick={() =>
            command.run((to) =>
              to.mutate('budget.set_planning_cap', { limitMinor: 7500, fromLimitMinor: 5000 }),
            )
          }
        >
          Save
        </button>
        {command.stepUp === null ? null : <StepUpPrompt ask={command.stepUp} />}
      </>
    );
  }
  function Screen() {
    const [client, setClient] = useState(oldClient);
    return (
      <StepUpContext.Provider
        value={async () => {
          await verified;
          setClient(newClient);
          return { ok: true, sessionId: 'stepped-up' };
        }}
      >
        <MoneyForm client={client} />
      </StepUpContext.Provider>
    );
  }
  const view = await mount(<Screen />);
  try {
    await view.click('[data-send]');
    await view.type('[data-step-up="code"]', '123456');
    await view.click('[data-step-up="confirm"]');
    expect(view.find('[data-step-up="confirm"]')?.textContent).toBe('Checking…');
    await view.click('[data-step-up="cancel"]');
    expect(view.find('[data-step-up="prompt"]')).toBeNull();
    await act(async () => {
      finish();
      await verified;
    });
    expect(sent).toHaveLength(1);
  } finally {
    await view.unmount();
  }
});
