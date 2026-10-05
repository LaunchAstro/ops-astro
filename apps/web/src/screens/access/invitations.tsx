// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Access's team invitations (C39-T, CS-2.19): the business's
// invitations as `invitation.list` answers them, under `access:share`, each
// with its state (pending, accepted, revoked or expired) and its sent and
// expiry times. A pending one has its two acts, `invitation.resend` and
// `invitation.revoke`, the commands the API and the command line reach. After
// an act, refused or not, the list is read again, so a state shown is always
// the server's. While one act is out, every row's buttons are held.
// Resending an administrator's invitation asks `access:manage` too (SEC27), so
// without it that row offers Revoke alone and says why; a revoke stays
// `access:share`.

import { useEffect, useRef, type ReactElement } from 'react';
import { Button, Card, Chip, Table, type MarkTone } from '@launchastro/ui';
import { useRead } from '../../data/use-read.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { RecordState } from '../../views/record-state.tsx';
import type {
  InvitationListResult,
  InvitationRole,
  InvitationState,
  InvitationView,
} from '../../../../../packages/core-wire/src/index.ts';

const TONE: Record<InvitationState, MarkTone> = {
  pending: 'info',
  accepted: 'ok',
  revoked: 'idle',
  expired: 'warn',
};

const ROLE_WORDS: Readonly<Record<InvitationRole, string>> = {
  member: 'Team member',
  admin: 'Administrator',
};

/** A role in words; one the screen has no words for is drawn as the server named it. */
const roleWords = (role: string): string =>
  Object.hasOwn(ROLE_WORDS, role) ? ROLE_WORDS[role as InvitationRole] : role;

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

/** What a row's acts take besides the row: the act, and what the session holds. */
interface ActsProps {
  readonly onAct: InvitationAct;
  readonly canManage: boolean;
  readonly busy: boolean;
}

function Acts(props: ActsProps & { readonly row: InvitationView }) {
  if (props.row.state !== 'pending') return null;
  const resendable = props.canManage || props.row.role !== 'admin';
  return (
    <span data-invitation-acts={props.row.invitationId}>
      {resendable ? (
        <span data-act="resend">
          <Button
            variant="ghost"
            disabled={props.busy}
            onClick={() => props.onAct('invitation.resend', props.row)}
          >
            Resend
          </Button>
        </span>
      ) : (
        <span data-act-needs="access:manage">
          Resending an administrator&apos;s invitation needs access:manage.
        </span>
      )}
      <span data-act="revoke">
        <Button disabled={props.busy} onClick={() => props.onAct('invitation.revoke', props.row)}>
          Revoke
        </Button>
      </span>
    </span>
  );
}

function rowOf(row: InvitationView, acts: ActsProps) {
  return {
    who: (
      <span data-invitation={row.invitationId}>
        {row.name} · {row.address}
      </span>
    ),
    role: roleWords(row.role),
    state: (
      <span data-state={row.state}>
        <Chip tone={TONE[row.state]}>{row.state}</Chip>
      </span>
    ),
    when: `${row.sentAt === null ? 'Not sent' : minute(row.sentAt)} · ${minute(row.expiresAt)}`,
    act: <Acts row={row} {...acts} />,
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
  /** An act of the section is out. */
  readonly busy: boolean;
}): ReactElement {
  const { client } = props;
  const { state, reload } = useRead<InvitationListResult>({
    grantKey: props.grantKey,
    run: () => client.read<InvitationListResult>('invitation.list', {}),
    isEmpty: (value) => value.invitations.length === 0,
    deps: [client],
  });
  // Read again in place after each act, keeping the rows drawn meanwhile.
  const seen = useRef(props.version);
  useEffect(() => {
    if (seen.current === props.version) return;
    seen.current = props.version;
    reload();
  }, [props.version, reload]);
  return (
    <div data-access="invitations">
      <Card title="Invitations" sub="Each pending until accepted, resent, revoked or expired" flush>
        <RecordState state={state} subject="invitations" onRetry={reload}>
          {(result) => (
            <Table
              caption="Invitations"
              columns={COLUMNS}
              rows={result.invitations.map((row) =>
                rowOf(row, { onAct: props.onAct, canManage: props.canManage, busy: props.busy }),
              )}
            />
          )}
        </RecordState>
      </Card>
    </div>
  );
}
