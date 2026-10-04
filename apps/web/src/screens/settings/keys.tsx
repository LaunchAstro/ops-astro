// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Keys (C31): custody's secrets as set or not set.
//
// The panel reads `secret.list` and writes through `secret.set` and `secret.clear`, the one
// command family both secret screens use. It never holds a value longer than the field the
// person is typing into: the input is masked, uncontrolled text (a password field would hand it
// to the browser's password manager; a controlled one would mirror it into the page), it is
// emptied as soon as the set is sent, and no answer the server gives carries a value to draw.
// What a row shows is its name, its scope, whether it is set, and when it was last used.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
  type SyntheticEvent,
} from 'react';
import { Chip, Empty } from '@launchastro/ui';
import type { SecretListResult, SecretView } from '../../../../../packages/core-wire/src/index.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../../operations/client.ts';

type Listing =
  | { readonly state: 'loading' }
  | {
      readonly state: 'shown';
      readonly secrets: readonly SecretView[];
      /** The key held business-wide: only then are Set and Clear offered. */
      readonly canChange: boolean;
    }
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
  // Only the latest read draws: an older answer, authorised or not, is dropped.
  const latest = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    latest.current += 1;
    const mine = latest.current;
    const answer = await client.read<SecretListResult>('secret.list', {});
    if (mine !== latest.current) return;
    if (isUnavailable(answer)) setListing({ state: 'unavailable', because: answer.because });
    else if (isRefusal(answer))
      setListing({ state: 'refused', because: answer.fixes[0] ?? answer.code });
    else
      setListing({
        state: 'shown',
        secrets: answer.value.secrets,
        canChange: answer.value.canChange,
      });
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (run: () => ReturnType<OperationsClient['mutate']>): Promise<void> => {
    const answer = await run();
    if (isUnavailable(answer)) setBecause(answer.because);
    else if (isRefusal(answer)) setBecause(`${answer.code}: ${answer.names.join(', ')}`);
    else setBecause(null);
    // A newer denial drops the rows and controls at once, whatever the reread does.
    if (isRefusal(answer) && answer.code === 'SCOPE_NOT_GRANTED')
      setListing({ state: 'refused', because: answer.fixes[0] ?? answer.code });
    await load();
  };

  return { listing, because, act };
}

function KeyRows(props: {
  readonly secrets: readonly SecretView[];
  /** Absent for a holder who may only list. */
  readonly clear?: (secret: SecretView) => void;
}): ReactElement {
  const { clear } = props;
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
            {secret.state === 'set' && clear !== undefined ? (
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => {
                  clear(secret);
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

/** The name field: an ordinary text field, autofill and spelling off. */
function NameField(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactElement {
  return (
    <div className="field">
      <label className="field__label" htmlFor="key-name">
        Name
      </label>
      <input
        id="key-name"
        className="tf"
        type="text"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
    </div>
  );
}

const refuse = (event: SyntheticEvent): void => {
  event.preventDefault();
};

/**
 * The value field. Masked text, never a password field: a password manager
 * would offer to save the value, or fill a login into it. It is uncontrolled,
 * so React never mirrors the value into the page's `value` attribute, and it
 * refuses copy, cut and drag. Autofill, spelling and the managers' own
 * opt-outs are all off.
 */
function ValueField(props: {
  readonly field: RefObject<HTMLInputElement | null>;
  readonly onFilled: (filled: boolean) => void;
}): ReactElement {
  return (
    <div className="field">
      <label className="field__label" htmlFor="key-value">
        Value
      </label>
      <input
        id="key-value"
        ref={props.field}
        className="tf tf--sealed"
        type="text"
        onInput={(event) => props.onFilled(event.currentTarget.value !== '')}
        onCopy={refuse}
        onCut={refuse}
        onDragStart={refuse}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        data-1p-ignore=""
        data-lpignore="true"
        data-settings="key-value"
      />
    </div>
  );
}

function KeyForm(props: { readonly set: (name: string, value: string) => void }): ReactElement {
  const [name, setName] = useState('');
  const [filled, setFilled] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  return (
    <form
      className="form"
      aria-label="Set a key"
      onSubmit={(event) => {
        event.preventDefault();
        const sent = field.current?.value ?? '';
        // Emptied before the answer: the value is not kept while the request is out.
        if (field.current !== null) field.current.value = '';
        setFilled(false);
        props.set(name, sent);
      }}
    >
      <div className="form__grid">
        <NameField value={name} onChange={setName} />
        <ValueField field={field} onFilled={setFilled} />
      </div>
      <div className="form__actions">
        <button
          type="submit"
          className="btn btn--primary btn--sm"
          disabled={name === '' || !filled}
        >
          Set key
        </button>
      </div>
    </form>
  );
}

function KeysHead(): ReactElement {
  return (
    <div className="card__head">
      <div>
        <h3 className="card__title">Keys</h3>
        <p className="card__sub">
          Secrets the business&apos;s connections use. A value is sealed when you set it and is
          never shown again, here or anywhere.
        </p>
      </div>
    </div>
  );
}

/** The listing while it is not drawn: reading, refused or unavailable. */
function NotShown(props: { readonly listing: Listing }): ReactElement | null {
  const { listing } = props;
  if (listing.state === 'loading') return <p className="card__note">Reading keys…</p>;
  if (listing.state === 'refused') {
    return <Empty title="You are not permitted to see the keys." description={listing.because} />;
  }
  if (listing.state === 'unavailable') {
    return (
      <p className="field__error card__note" role="status">
        {listing.because}
      </p>
    );
  }
  return null;
}

export function KeysPanel(props: { readonly client: OperationsClient }): ReactElement {
  const { client } = props;
  const { listing, because, act } = useKeys(client);
  return (
    <section className="card card--flush" data-settings="keys">
      <KeysHead />
      <NotShown listing={listing} />
      {listing.state === 'shown' ? (
        <KeyRows
          secrets={listing.secrets}
          {...(listing.canChange
            ? {
                clear: (secret: SecretView) => {
                  void act(
                    async () =>
                      await client.mutate('secret.clear', {
                        secretId: secret.id,
                        expectedRevision: secret.revision,
                      }),
                  );
                },
              }
            : {})}
        />
      ) : null}
      {because === null ? null : (
        <p className="field__error card__note" role="alert" data-settings="keys-refusal">
          {because}
        </p>
      )}
      {listing.state === 'shown' && listing.canChange ? (
        <KeyForm
          set={(name, value) => {
            const listed = listing.secrets.find((s) => s.name === name && s.clientId === null);
            const sent = { name, value, expectedRevision: listed?.revision ?? 0 };
            void act(async () => await client.mutate('secret.set', sent));
          }}
        />
      ) : null}
    </section>
  );
}
