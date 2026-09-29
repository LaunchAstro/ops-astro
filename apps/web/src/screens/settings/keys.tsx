// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Keys (C31): custody's secrets as set or not set.
//
// The panel reads `secret.list` and writes through `secret.set` and
// `secret.clear`, the one command family both secret screens use. It never
// holds a value longer than the field the person is typing into: the input is
// a password field, it is emptied as soon as the set is sent, and no answer the
// server gives carries a value to draw. What a row shows is its name, its
// scope, whether it is set, and when it was last used.

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import type { SecretView } from '../../../../../packages/core-wire/src/index.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../../operations/client.ts';

type Listing =
  | { readonly state: 'loading' }
  | { readonly state: 'shown'; readonly secrets: readonly SecretView[] }
  | { readonly state: 'refused'; readonly because: string }
  | { readonly state: 'unavailable'; readonly because: string };

function when(at: string | null): string {
  return at === null ? 'never' : new Date(at).toLocaleString();
}

export function KeysPanel(props: { readonly client: OperationsClient }): ReactElement {
  const { client } = props;
  const [listing, setListing] = useState<Listing>({ state: 'loading' });
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [because, setBecause] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const answer = await client.read<{ readonly secrets: readonly SecretView[] }>(
      'secret.list',
      {},
    );
    if (isUnavailable(answer)) setListing({ state: 'unavailable', because: answer.because });
    else if (isRefusal(answer))
      setListing({ state: 'refused', because: answer.fixes[0] ?? answer.code });
    else setListing({ state: 'shown', secrets: answer.value.secrets });
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (run: () => ReturnType<OperationsClient['mutate']>): Promise<void> => {
    const answer = await run();
    if (isUnavailable(answer)) setBecause(answer.because);
    else if (isRefusal(answer)) setBecause(`${answer.code}: ${answer.names.join(', ')}`);
    else setBecause(null);
    await load();
  };

  const save = (): void => {
    const sent = value;
    // Emptied before the answer: the value is not kept while the request is out.
    setValue('');
    void act(async () => await client.mutate('secret.set', { name, value: sent }));
  };

  return (
    <section className="sb__sect" data-settings="keys">
      <div className="sb__sh">
        <span className="sb__k">Keys</span>
      </div>
      <p className="card__sub">
        Secrets the business&apos;s connections use. A value is sealed when you set it and is never
        shown again, here or anywhere.
      </p>
      {listing.state === 'loading' ? <p className="card__sub">Reading keys…</p> : null}
      {listing.state === 'refused' ? (
        <Empty title="You are not permitted to see the keys." description={listing.because} />
      ) : null}
      {listing.state === 'unavailable' ? (
        <p className="field__error" role="status">
          {listing.because}
        </p>
      ) : null}
      {listing.state === 'shown' ? (
        <ul className="stack" data-settings="key-rows">
          {listing.secrets.map((secret) => (
            <li key={secret.id} data-secret={secret.name} data-state={secret.state}>
              <span className="sb__k">{secret.name}</span>{' '}
              <span>
                {secret.clientId === null ? 'whole business' : `client ${secret.clientId}`}
              </span>{' '}
              <strong>{secret.state}</strong> <span>last used {when(secret.lastUsedAt)}</span>{' '}
              {secret.state === 'set' ? (
                <button
                  type="button"
                  onClick={() => {
                    void act(
                      async () => await client.mutate('secret.clear', { secretId: secret.id }),
                    );
                  }}
                >
                  Clear
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {because === null ? null : (
        <p className="field__error" role="alert" data-settings="keys-refusal">
          {because}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <label>
          Name{' '}
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
          />
        </label>{' '}
        <label>
          Value{' '}
          <input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            data-settings="key-value"
          />
        </label>{' '}
        <button type="submit" disabled={name === '' || value === ''}>
          Set key
        </button>
      </form>
    </section>
  );
}
