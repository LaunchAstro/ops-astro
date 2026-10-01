// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Access's invitation (C39-T, CS-2.19): "Invite a team member"
// takes a name, an address and a role and sends `invitation.create`, the
// command the API and the command line reach under `access:share`. The form
// guards nothing the server checks, so every refusal stays reachable: a
// refused field is drawn under that field in the server's words, and what was
// typed stays. Once the invitation is made the form is cleared.
//
// It is drawn only for a person whose session holds `access:share`
// (`session.capabilities`); the server still refuses anyone else.

import { useState, type FormEvent, type ReactElement } from 'react';
import { Button, Card, Select, TextField } from '@launchastro/ui';
import type { ReadState } from '../../data/authorised-read.ts';
import { isRefusal, type WireRefusal } from '../../operations/client.ts';
import type { SubmitResult } from '../../records/submit.ts';
import type { CapabilitiesResult } from '../../../../../packages/core-wire/src/index.ts';

/** What `invitation.create` takes: its operands, `surface-operands.ts`. */
export interface Invitation {
  readonly name: string;
  readonly email: string;
  readonly role: string;
}

/** The roles an invitation may name; an owner is never invited (`invitations.ts`). */
const ROLES = [
  { value: 'member', label: 'Team member' },
  { value: 'admin', label: 'Administrator' },
];

const BLANK: Invitation = { name: '', email: '', role: 'member' };

/** Does this session hold `access:share`? Not until the read says so. */
export const holdsShare = (state: ReadState<CapabilitiesResult>): boolean =>
  state.outcome === 'ready' &&
  state.value.grants.some((each) => each.collection === 'access' && each.action === 'share');

/** The server's fixes, under the field its refusal names. */
const errorOf = (refusal: WireRefusal | null, field: keyof Invitation): string | undefined =>
  refusal?.names.includes(field) === true ? refusal.fixes.join(' ') || 'Refused.' : undefined;

/** The typed fields and the last refusal; cleared once an invitation is made. */
function useInvite(onInvite: (invitation: Invitation) => Promise<SubmitResult>) {
  const [fields, setFields] = useState<Invitation>(BLANK);
  const [refusal, setRefusal] = useState<WireRefusal | null>(null);
  const set = (field: keyof Invitation) => (value: string) => {
    setFields((was) => ({ ...was, [field]: value }));
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void (async () => {
      const result = await onInvite(fields);
      setRefusal(isRefusal(result) ? result : null);
      if ('ok' in result) setFields(BLANK);
    })();
  };
  return { fields, refusal, set, submit };
}

export function InviteMember(props: {
  readonly busy: boolean;
  readonly onInvite: (invitation: Invitation) => Promise<SubmitResult>;
}): ReactElement {
  const { fields, refusal, set, submit } = useInvite(props.onInvite);
  const text = (field: 'name' | 'email', label: string) => (
    <div data-field={field}>
      <TextField
        label={label}
        value={fields[field]}
        onChange={set(field)}
        error={errorOf(refusal, field)}
      />
    </div>
  );
  return (
    <div data-access="invite">
      <Card
        title="Invite a team member"
        sub="Emailed a one-time link; pending until it is accepted, resent, revoked or expires"
      >
        <form className="stack" onSubmit={submit}>
          {text('name', 'Name')}
          {text('email', 'Email')}
          <div data-field="role">
            <Select
              label="Role"
              value={fields.role}
              onChange={set('role')}
              options={ROLES}
              error={errorOf(refusal, 'role')}
            />
          </div>
          <div className="btnrow">
            <Button type="submit" variant="primary" busy={props.busy ? 'Inviting…' : undefined}>
              Send invitation
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
