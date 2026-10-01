// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ General's "Your sessions" (C58): a person sees their own
// live sessions and can end every one but this.
//
// Both calls are the person's own account routes with an empty body
// (`account/sessions/list` and `account/sessions/end-others`, served by
// `core-commands/src/commands/account-sessions.ts`). The server takes the
// person and this session from the credential, so this panel has nothing to
// name another person, another session or an agent with, and this session is
// never among those ended. A session is drawn by when it started and when it
// was last seen; its id is never on the page. Ending is
// confirmed first, as End access is on Settings ▸ Access; then the list is read
// again. A refusal is shown in the server's words, code first, and the list
// stays as it was.

import { useState, type ReactElement } from 'react';
import { Button, Card, Table } from '@launchastro/ui';
import { useRead } from '../../data/use-read.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { describeFailure } from '../../records/submit.ts';
import { RecordState } from '../../views/record-state.tsx';

/** `SessionView` as `listOwnSessions` answers it. */
interface SessionView {
  readonly sessionId: string;
  readonly current: boolean;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

interface SessionsList {
  readonly sessions: readonly SessionView[];
}

/** `SessionsEnded` as `endOtherSessions` answers it. */
interface SessionsEnded {
  readonly ended: number;
  readonly signedOutAtProvider: boolean;
}

const COLUMNS = [
  { key: 'which', label: 'Session' },
  { key: 'started', label: 'Started' },
  { key: 'seen', label: 'Last seen' },
];

function SessionsTable(props: { readonly sessions: readonly SessionView[] }): ReactElement {
  const rows = props.sessions.map((session) => ({
    which: session.current ? 'This session' : 'Another session',
    started: session.firstSeenAt,
    seen: session.lastSeenAt,
  }));
  return (
    <div data-sessions="list">
      <Table caption="Your sessions" columns={COLUMNS} rows={rows} />
    </div>
  );
}

function ConfirmEndOthers(props: {
  readonly onEnd: () => void;
  readonly onKeep: () => void;
}): ReactElement {
  return (
    <div data-confirm="end-others">
      <Card
        title="Sign out your other sessions?"
        sub="Every session of yours but this one ends now, on every device. This one stays signed in."
      >
        <span data-act="end">
          <Button variant="primary" onClick={props.onEnd}>
            Sign out other sessions now
          </Button>
        </span>
        <span data-act="keep">
          <Button variant="ghost" onClick={props.onKeep}>
            Keep them
          </Button>
        </span>
      </Card>
    </div>
  );
}

const endedInWords = (result: SessionsEnded): string =>
  `Signed out ${String(result.ended)} other session${result.ended === 1 ? '' : 's'}.` +
  (result.signedOutAtProvider ? '' : ' The sign-in provider has not confirmed it yet.');

/** "Sign out other sessions": confirmed first, then one end-others, then the list again. */
function useEndOthers(client: OperationsClient, reload: () => void) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const endOthers = (): void => {
    setConfirming(false);
    setBusy(true);
    void (async () => {
      const result = await client.account<SessionsEnded>('sessions/end-others');
      setBusy(false);
      setOutcome('ok' in result ? endedInWords(result.value) : describeFailure(result));
      if ('ok' in result) reload();
    })();
  };
  return { confirming, setConfirming, busy, outcome, endOthers };
}

export function OwnSessions(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
}): ReactElement {
  const { client, grantKey } = props;
  const { state, reload } = useRead<SessionsList>({
    grantKey,
    run: () => client.account<SessionsList>('sessions/list'),
    deps: [client],
  });
  const { confirming, setConfirming, busy, outcome, endOthers } = useEndOthers(client, reload);
  return (
    <section className="sb__sect" data-sessions="panel">
      <Card title="Your sessions" sub="Where you are signed in now, newest first.">
        <RecordState state={state} subject="sessions" onRetry={reload}>
          {(list) => (
            <div className="stack">
              {outcome === null ? null : (
                <p className="card__sub" role="status" data-sessions-outcome>
                  {outcome}
                </p>
              )}
              <SessionsTable sessions={list.sessions} />
              {confirming ? (
                <ConfirmEndOthers onEnd={endOthers} onKeep={() => setConfirming(false)} />
              ) : null}
              <span data-sessions="end-others">
                <Button
                  busy={busy ? 'Signing out…' : undefined}
                  disabled={!list.sessions.some((session) => !session.current)}
                  reason="You have no other session."
                  onClick={() => setConfirming(true)}
                >
                  Sign out other sessions
                </Button>
              </span>
            </div>
          )}
        </RecordState>
      </Card>
    </section>
  );
}
