// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Access's agent credential (API-2, owner check U18): a person
// makes one for themselves with task access only, `task:read` and
// `task:write` over the whole business, through `credential.issue`, and
// revokes it with `credential.revoke` by its id. It is drawn only when
// `session.capabilities` says the session holds `credential:write`; the
// server still refuses anyone else, and any key the person does not hold.
//
// The secret is in the issue answer alone. It is drawn once, in a read-only
// field, until the person hides it or the page goes; it is in no outcome
// line, no storage and no log. What stays is the credential's id, purpose and
// expiry, so it can be revoked while the page is open. `access.read` lists no
// agent credential, so one made earlier is revoked from the command line.
//
// One operation id and one body per intent, held until an answer arrives, so
// a retry after a lost answer replays the first issue (which derives the same
// secret again) instead of making a second credential. A business or person
// switch answers the capabilities read loading, so the section unmounts and
// the secret, the list and any answer still out go with it.

import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Button, Card, Chip, Select, TextField } from '@launchastro/ui';
import type { ReadState } from '../../data/authorised-read.ts';
import { isUnavailable, type OperationsClient } from '../../operations/client.ts';
import type { SubmitResult } from '../../records/submit.ts';
import type { CapabilitiesResult } from '../../../../../packages/core-wire/src/index.ts';
import { useAct } from './use-act.tsx';

/** Task access only: never decide, share, manage or a money key (`credential-write.ts`). */
const TASK_ONLY = [
  { collection: 'task', action: 'read' },
  { collection: 'task', action: 'write' },
] as const;

/** How long it lives; the server's limit is 90 days (`CREDENTIAL_MAX_DAYS`). */
const LIVES = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

export const holdsCredentialWrite = (state: ReadState<CapabilitiesResult>): boolean =>
  state.outcome === 'ready' &&
  state.value.grants.some((grant) => grant.collection === 'credential' && grant.action === 'write');

interface Made {
  readonly credentialId: string;
  readonly purpose: string;
  readonly expiresAt: string;
  readonly revoked: boolean;
}

type Issue = {
  readonly scope: typeof TASK_ONLY;
  readonly purpose: string;
  readonly expiresAt: string;
};

/** The issue answer's credential and secret, or null when it names neither. */
function issuedOf(result: SubmitResult, purpose: string): { made: Made; secret: string } | null {
  if (!('ok' in result)) return null;
  const detail = result.value.detail ?? {};
  const { credentialId, expiresAt, credential } = detail;
  if (typeof credentialId !== 'string' || typeof credential !== 'string') return null;
  const at = typeof expiresAt === 'string' ? expiresAt : '';
  return { made: { credentialId, purpose, expiresAt: at, revoked: false }, secret: credential };
}

/** One operation id and body per intent, kept until an answer arrives. */
function useIssue(client: OperationsClient) {
  const intent = useRef<{ readonly key: string; readonly id: string; readonly body: Issue }>(null);
  return (purpose: string, days: string) => {
    const key = `${purpose}\n${days}`;
    if (intent.current?.key !== key) {
      const expiresAt = new Date(Date.now() + Number(days) * DAY_MS).toISOString();
      const body = { scope: TASK_ONLY, purpose, expiresAt };
      intent.current = { key, id: client.newOperationId(), body };
    }
    const { id, body } = intent.current;
    return async (): Promise<SubmitResult> => {
      const answer = await client.mutate('credential.issue', body, { operationId: id });
      if (!isUnavailable(answer)) intent.current = null;
      return answer;
    };
  };
}

function Secret(props: { readonly secret: string; readonly onHide: () => void }): ReactElement {
  return (
    <div className="stack" data-credential-new>
      <label className="field__label" htmlFor="agent-credential-secret">
        The credential, shown only this once: copy it now
      </label>
      <input
        id="agent-credential-secret"
        className="tf"
        readOnly
        value={props.secret}
        data-credential-secret
        onFocus={(event) => event.target.select()}
      />
      <span data-act="hide-secret">
        <Button variant="ghost" onClick={props.onHide}>
          Hide it
        </Button>
      </span>
    </div>
  );
}

function MadeRow(props: {
  readonly made: Made;
  readonly busy: boolean;
  readonly onRevoke: () => void;
}): ReactElement {
  const { made } = props;
  const until =
    made.expiresAt === '' ? '' : ` · until ${new Date(made.expiresAt).toLocaleString()}`;
  return (
    <div className="setrow" data-credential={made.credentialId}>
      <span>
        {made.purpose}
        {until}
      </span>
      {made.revoked ? (
        <Chip>Revoked</Chip>
      ) : (
        <span data-act="revoke">
          <Button onClick={props.onRevoke} disabled={props.busy}>
            Revoke credential
          </Button>
        </span>
      )}
    </div>
  );
}

/** The section's acts: the issue, the secret it answered, and what was made, each revocable. */
function useCredentials(client: OperationsClient) {
  const { act, busy, outcome } = useAct(() => null);
  const issue = useIssue(client);
  const [secret, setSecret] = useState<string | null>(null);
  const [made, setMade] = useState<readonly Made[]>([]);
  /** True once the issue answered a credential, so the form may clear what was sent. */
  const make = async (purpose: string, days: string): Promise<boolean> => {
    const result = await act(issue(purpose, days), `Made an agent credential for ${purpose}.`);
    const issued = result === null ? null : issuedOf(result, purpose);
    if (issued === null) return false;
    setSecret(issued.secret);
    setMade((was) => [...was, issued.made]);
    return true;
  };
  const revoke = async (one: Made): Promise<void> => {
    const result = await act(
      () => client.mutate('credential.revoke', { credentialId: one.credentialId }),
      `Revoked the agent credential for ${one.purpose}. Its next command is refused.`,
    );
    if (result === null || !('ok' in result)) return;
    setSecret(null);
    setMade((was) =>
      was.map((each) =>
        each.credentialId === one.credentialId ? { ...each, revoked: true } : each,
      ),
    );
  };
  return { busy, outcome, secret, hide: () => setSecret(null), made, make, revoke };
}

function MakeForm(props: {
  readonly busy: boolean;
  readonly onMake: (purpose: string, days: string) => Promise<boolean>;
}): ReactElement {
  const [purpose, setPurpose] = useState('');
  const [days, setDays] = useState('30');
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const typed = purpose.trim();
    if (typed === '') return;
    void (async () => {
      // Only the purpose that was sent is cleared; anything typed since stays.
      if (await props.onMake(typed, days)) setPurpose((was) => (was.trim() === typed ? '' : was));
    })();
  };
  return (
    <form className="stack" onSubmit={submit}>
      <div data-field="purpose">
        <TextField label="What it is for" value={purpose} onChange={setPurpose} />
      </div>
      <div data-field="life">
        <Select label="Lasts" value={days} onChange={setDays} options={LIVES} />
      </div>
      <div className="btnrow" data-act="make">
        <Button
          type="submit"
          variant="primary"
          busy={props.busy ? 'Making the credential…' : undefined}
          disabled={purpose.trim() === ''}
        >
          Make agent credential
        </Button>
      </div>
    </form>
  );
}

export function AgentCredential(props: { readonly client: OperationsClient }): ReactElement {
  const { busy, outcome, secret, hide, made, make, revoke } = useCredentials(props.client);
  return (
    <section className="sec" data-access-section="credential">
      {outcome}
      <div data-access="credential">
        <Card
          title="Agent credential"
          sub="For an agent of yours on the command line or the API: task:read and task:write over the whole business, nothing else"
        >
          {secret === null ? null : <Secret secret={secret} onHide={hide} />}
          <div className="set">
            {made.map((each) => (
              <MadeRow
                key={each.credentialId}
                made={each}
                busy={busy}
                onRevoke={() => void revoke(each)}
              />
            ))}
          </div>
          <MakeForm busy={busy} onMake={make} />
        </Card>
      </div>
    </section>
  );
}
