// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Access's team invitations (C39-T, CS-2.19): the business's
// invitations as `invitation.list` answers them, under `access:share`, each
// with its state (pending, accepted, revoked or expired) and its sent and
// expiry times. A pending one has its two acts, `invitation.resend` and
// `invitation.revoke`, the commands the API and the command line reach. After
// an act the list is read again, so a state shown is always the server's.
// Resending an administrator's invitation asks `access:manage` too (SEC27), so
// without it that row offers Revoke alone and says why; a revoke stays
// `access:share`.

import type { ReactElement } from 'react';
import { Button, Card, Chip, Table, type MarkTone } from '@launchastro/ui';
import { useRead } from '../../data/use-read.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { RecordState } from '../../views/record-state.tsx';
import type {
  InvitationListResult,
  InvitationState,
  InvitationView,
} from '../../../../../packages/core-wire/src/index.ts';

const TONE: Record<InvitationState, MarkTone> = {
  pending: 'info',
  accepted: 'ok',
  revoked: 'idle',
  expired: 'warn',
};

const ROLE_WORDS: Readonly<Record<string, string>> = {
  member: 'Team member',
  admin: 'Administrator',
};

/** A time as the server sent it, to the minute, in UTC. */
const minute = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

const COLUMNS = [
  { key: 'who', label: 'Invited' },
  { key: 'role', label: 'Role' },
  { key: 'state', label: 'State' },
  { key: 'when', label: 'Sent · expires' },
  { key: 'act', label: '', align: 'end' as const },
];

/** One act on one pending invitation, by its id. */
export type InvitationAct = (
  command: 'invitation.resend' | 'invitation.revoke',
  invitation: InvitationView,
) => void;

function Acts(props: {
  readonly row: InvitationView;
  readonly onAct: InvitationAct;
  readonly canManage: boolean;
}) {
  if (props.row.state !== 'pending') return null;
  const resendable = props.canManage || props.row.role !== 'admin';
  return (
    <span data-invitation-acts={props.row.invitationId}>
      {resendable ? (
        <span data-act="resend">
          <Button variant="ghost" onClick={() => props.onAct('invitation.resend', props.row)}>
            Resend
          </Button>
        </span>
      ) : (
        <span data-act-needs="access:manage">
          Resending an administrator&apos;s invitation needs access:manage.
        </span>
      )}
      <span data-act="revoke">
        <Button onClick={() => props.onAct('invitation.revoke', props.row)}>Revoke</Button>
      </span>
    </span>
  );
}

function rowOf(row: InvitationView, onAct: InvitationAct, canManage: boolean) {
  return {
    who: (
      <span data-invitation={row.invitationId}>
        {row.name} · {row.address}
      </span>
    ),
    role: ROLE_WORDS[row.role] ?? row.role,
    state: (
      <span data-state={row.state}>
        <Chip tone={TONE[row.state]}>{row.state}</Chip>
      </span>
    ),
    when: `${row.sentAt === null ? 'Not sent' : minute(row.sentAt)} · ${minute(row.expiresAt)}`,
    act: <Acts row={row} onAct={onAct} canManage={canManage} />,
  };
}

export function Invitations(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  /** Moved on after each act that worked, so the list is read again. */
  readonly version: number;
  readonly onAct: InvitationAct;
  /** The session holds `access:manage`, which resending an administrator's invitation asks. */
  readonly canManage: boolean;
}): ReactElement {
  const { client } = props;
  const { state, reload } = useRead<InvitationListResult>({
    grantKey: props.grantKey,
    run: () => client.read<InvitationListResult>('invitation.list', {}),
    isEmpty: (value) => value.invitations.length === 0,
    deps: [client, props.version],
  });
  return (
    <div data-access="invitations">
      <Card title="Invitations" sub="Each pending until accepted, resent, revoked or expired" flush>
        <RecordState state={state} subject="invitations" onRetry={reload}>
          {(result) => (
            <Table
              caption="Invitations"
              columns={COLUMNS}
              rows={result.invitations.map((row) => rowOf(row, props.onAct, props.canManage))}
            />
          )}
        </RecordState>
      </Card>
    </div>
  );
}
