// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable require-await -- Sol's proof, kept as written */

import { useState } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { Propose, TopUp, type ProposeDraft } from '../../apps/web/src/views/propose-form.tsx';
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

// Sol OW-099.2 criterion 4, retitled by what it proves; its body is Sol's.
it('a KWD proposal can send one minor unit through native form validation', async () => {
  const sent: Record<string, unknown>[] = [];
  const client = clientWith((body) => {
    sent.push(body);
    return Response.json({ recordId: 'task-1', revision: 1, detail: {} });
  });
  function Form() {
    const [draft, setDraft] = useState<ProposeDraft | null>(null);
    return (
      <Propose
        client={client}
        recordId="task-1"
        revision={1}
        capCurrency="KWD"
        draft={draft}
        onDraft={setDraft}
        refusal={null}
        onRefused={() => {}}
        onChanged={() => {}}
      />
    );
  }
  const view = await mount(<Form />);
  try {
    await view.type('#propose-purpose', 'send_reply');
    await view.type('#propose-maximum', '0.01');
    await view.click('[data-propose="submit"]');
    expect(sent.map((body) => body['maximumMinor'])).toEqual([10]);
    sent.length = 0;
    await view.type('#propose-purpose', 'send_reply');
    await view.type('#propose-maximum', '0.001');
    await view.click('[data-propose="submit"]');
    expect(sent.map((body) => body['maximumMinor'])).toEqual([1]);
  } finally {
    await view.unmount();
  }
});

// Sol OW-099.3 criterion correctness, retitled by what it proves; its body is Sol's.
it('a valid numeric top-up in exponent notation is sent', async () => {
  const sent: Record<string, unknown>[] = [];
  const client = clientWith((body) => {
    sent.push(body);
    return Response.json({ recordId: 'task-1', revision: null, detail: {} });
  });
  const view = await mount(
    <TopUp
      client={client}
      recordId="task-1"
      note={null}
      envelope={{
        id: 'env-1',
        capId: 'cap-1',
        currency: 'AUD',
        maximumMinor: 10000,
        heldMinor: 0,
        actualMinor: 0,
      }}
      onNote={() => {}}
      onChanged={() => {}}
    />,
  );
  try {
    await view.type('#top-up-amount', '100');
    await view.click('[data-top-up="submit"]');
    expect(sent.map((body) => body['amountMinor'])).toEqual([10000]);
    sent.length = 0;
    await view.type('#top-up-amount', '1e2');
    expect(view.host.querySelector<HTMLInputElement>('#top-up-amount')?.checkValidity()).toBe(true);
    await view.click('[data-top-up="submit"]');
    expect(sent.map((body) => body['amountMinor'])).toEqual([10000]);
  } finally {
    await view.unmount();
  }
});
