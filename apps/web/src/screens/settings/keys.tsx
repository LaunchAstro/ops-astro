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
import { Chip, Empty } from '@launchastro/ui';
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

function useKeys(client: OperationsClient): {
  readonly listing: Listing;
  readonly because: string | null;
  readonly act: (run: () => ReturnType<OperationsClient['mutate']>) => Promise<void>;
} {
  const [listing, setListing] = useState<Listing>({ state: 'loading' });
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

  return { listing, because, act };
}

function KeyRows(props: {
  readonly secrets: readonly SecretView[];
  readonly clear: (secret: SecretView) => void;
}): ReactElement {
  return (
    <ul className="lrows" data-settings="key-rows">
      {props.secrets.map((secret) => (
        <li
          key={secret.id}
          className="lrow lrow--page"
          data-secret={secret.name}
          data-state={secret.state}
        >
          <span className="lrow__main">
            <span className="lrow__title">{secret.name}</span>
            <span className="lrow__meta">
              {secret.clientId === null ? 'Whole business' : `Client ${secret.clientId}`} · last
              used {when(secret.lastUsedAt)}
            </span>
          </span>
          <span className="lrow__trail">
            <Chip kind="soft" tone={secret.state === 'set' ? 'ok' : 'idle'}>
              {secret.state === 'set' ? 'Set' : 'Not set'}
            </Chip>
            {secret.state === 'set' ? (
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => {
                  props.clear(secret);
                }}
              >
                Clear
              </button>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One field of the set form; a sealed one is a password field and is never read back. */
function KeyField(props: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly sealed?: boolean;
}): ReactElement {
  return (
    <div className="field">
      <label className="field__label" htmlFor={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        className="tf"
        type={props.sealed === true ? 'password' : 'text'}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        autoComplete="off"
        data-settings={props.sealed === true ? 'key-value' : undefined}
      />
    </div>
  );
}

function KeyForm(props: { readonly set: (name: string, value: string) => void }): ReactElement {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  return (
    <form
      className="form"
      aria-label="Set a key"
      onSubmit={(event) => {
        event.preventDefault();
        const sent = value;
        // Emptied before the answer: the value is not kept while the request is out.
        setValue('');
        props.set(name, sent);
      }}
    >
      <div className="form__grid">
        <KeyField id="key-name" label="Name" value={name} onChange={setName} />
        <KeyField id="key-value" label="Value" value={value} onChange={setValue} sealed />
      </div>
      <div className="form__actions">
        <button
          type="submit"
          className="btn btn--primary btn--sm"
          disabled={name === '' || value === ''}
        >
          Set key
        </button>
      </div>
    </form>
  );
}

export function KeysPanel(props: { readonly client: OperationsClient }): ReactElement {
  const { client } = props;
  const { listing, because, act } = useKeys(client);
  return (
    <section className="card card--flush" data-settings="keys">
      <div className="card__head">
        <div>
          <h3 className="card__title">Keys</h3>
          <p className="card__sub">
            Secrets the business&apos;s connections use. A value is sealed when you set it and is
            never shown again, here or anywhere.
          </p>
        </div>
      </div>
      {listing.state === 'loading' ? <p className="card__note">Reading keys…</p> : null}
      {listing.state === 'refused' ? (
        <Empty title="You are not permitted to see the keys." description={listing.because} />
      ) : null}
      {listing.state === 'unavailable' ? (
        <p className="field__error card__note" role="status">
          {listing.because}
        </p>
      ) : null}
      {listing.state === 'shown' ? (
        <KeyRows
          secrets={listing.secrets}
          clear={(secret) => {
            void act(async () => await client.mutate('secret.clear', { secretId: secret.id }));
          }}
        />
      ) : null}
      {because === null ? null : (
        <p className="field__error card__note" role="alert" data-settings="keys-refusal">
          {because}
        </p>
      )}
      <KeyForm
        set={(name, value) => {
          void act(async () => await client.mutate('secret.set', { name, value }));
        }}
      />
    </section>
  );
}
