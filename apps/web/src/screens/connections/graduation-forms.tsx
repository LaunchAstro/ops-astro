// SPDX-License-Identifier: AGPL-3.0-only
//
// The two forms of section 010 (MP-14-10a): the ceiling and expiry a promote
// needs, and a new standing mandate or refusal. Nothing is sent until every
// value it needs is set: an empty press moves focus to the first empty field
// and files nothing (AG-C54). The sentence is the mandate's label; the classes
// come from the client's scope list, and a refusal carries no ceiling.
//
// What is typed lives in the region's store (`graduation-drafts.ts`), above
// its read: each form draws its own client's slot and writes back to it, so
// an outage that takes the forms off the page gives them back as they were.

import { useRef, type ReactElement, type RefObject } from 'react';
import type { MandateDraft, MandateEdit, Promotion, PromotionEdit } from './graduation-drafts.ts';

/** The business currency record is not built; ceilings are Australian dollars. */
export const CURRENCY = 'AUD';

/**
 * Dollars and cents as typed, to whole cents, a leading $ and thousands commas
 * allowed ($1,000.50); anything else is not a ceiling.
 */
export function centsOf(typed: string): number | null {
  const match = /^\$?(\d{1,3}(?:,\d{3})+|\d{1,12})(?:\.(\d{1,2}))?$/u.exec(typed.trim());
  if (match === null) return null;
  const dollars = Number(String(match[1]).replaceAll(',', ''));
  return dollars * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/** A date as typed, to the end of that day where the reader is. */
export function expiryOf(typed: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(typed)) return null;
  const at = new Date(`${typed}T23:59:59`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

export interface Filing {
  readonly ceiling: { readonly amountMinor: number; readonly currency: string } | null;
  readonly expiresAt: string;
}

/** Focus the first field whose value did not parse; true when all did. */
function allSet(fields: readonly [boolean, RefObject<HTMLInputElement | null>][]): boolean {
  const empty = fields.find(([ok]) => !ok);
  empty?.[1].current?.focus();
  return empty === undefined;
}

/** The ceiling in dollars and the expiry date, the two values both forms need. */
function CeilingAndExpiry(props: {
  readonly what: string;
  readonly ceiling: string;
  readonly setCeiling: (value: string) => void;
  readonly ceilingRef: RefObject<HTMLInputElement | null>;
  readonly noCeiling?: boolean;
  readonly expiry: string;
  readonly setExpiry: (value: string) => void;
  readonly expiryRef: RefObject<HTMLInputElement | null>;
  readonly marks: 'promote' | 'mandate';
}): ReactElement {
  return (
    <>
      <input
        ref={props.ceilingRef}
        className="connnote__field"
        inputMode="decimal"
        aria-label={`Value ceiling${props.what}, in dollars`}
        placeholder="Ceiling, $"
        disabled={props.noCeiling === true}
        value={props.noCeiling === true ? '' : props.ceiling}
        onChange={(event) => props.setCeiling(event.target.value)}
        {...{ [`data-${props.marks}-ceiling`]: '' }}
      />
      <input
        ref={props.expiryRef}
        className="connnote__field"
        type="date"
        aria-label={`Expiry${props.what}`}
        value={props.expiry}
        onChange={(event) => props.setExpiry(event.target.value)}
        {...{ [`data-${props.marks}-expiry`]: '' }}
      />
    </>
  );
}

/** The ceiling and expiry as the store holds them, with the fields that draw them. */
function useCeilingAndExpiry(
  typed: { readonly ceiling: string; readonly expiry: string },
  edit: (change: { ceiling?: string; expiry?: string }) => void,
): {
  readonly ceiling: string;
  readonly setCeiling: (value: string) => void;
  readonly ceilingRef: RefObject<HTMLInputElement | null>;
  readonly expiry: string;
  readonly setExpiry: (value: string) => void;
  readonly expiryRef: RefObject<HTMLInputElement | null>;
} {
  const ceilingRef = useRef<HTMLInputElement>(null);
  const expiryRef = useRef<HTMLInputElement>(null);
  return {
    ceiling: typed.ceiling,
    setCeiling: (ceiling) => edit({ ceiling }),
    ceilingRef,
    expiry: typed.expiry,
    setExpiry: (expiry) => edit({ expiry }),
    expiryRef,
  };
}

export function PromoteForm(props: {
  readonly id: string;
  readonly label: string;
  readonly typed: Promotion;
  readonly edit: (change: PromotionEdit) => void;
  readonly promote: (filing: Filing) => void;
  readonly cancel: () => void;
  readonly locked: boolean;
}): ReactElement {
  const values = useCeilingAndExpiry(props.typed, props.edit);
  const confirm = (): void => {
    const cents = centsOf(values.ceiling);
    const expiresAt = expiryOf(values.expiry);
    const set = allSet([
      [cents !== null, values.ceilingRef],
      [expiresAt !== null, values.expiryRef],
    ]);
    if (!set || cents === null || expiresAt === null) return;
    props.promote({ ceiling: { amountMinor: cents, currency: CURRENCY }, expiresAt });
  };
  return (
    <div className="fieldrow" data-promote-form={props.id}>
      <CeilingAndExpiry what={` for ${props.label}`} marks="promote" {...values} />
      <button
        type="button"
        className="btn btn--sm btn--primary"
        disabled={props.locked}
        onClick={confirm}
        data-promote-confirm
      >
        Promote
      </button>
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        onClick={props.cancel}
        data-promote-cancel
      >
        Cancel
      </button>
    </div>
  );
}

export interface MandateFiling extends Filing {
  readonly classes: readonly string[];
  readonly refuses: boolean;
  readonly label: string;
}

function ScopePicker(props: {
  readonly scopes: readonly string[];
  readonly scope: string;
  readonly setScope: (value: string) => void;
  readonly refuses: boolean;
  readonly setRefuses: (value: boolean) => void;
}): ReactElement {
  return (
    <>
      <select
        aria-label="Action classes"
        value={props.scope}
        onChange={(event) => props.setScope(event.target.value)}
        data-mandate-scope
      >
        {props.scopes.map((one) => (
          <option key={one} value={one}>
            {one === '*' ? 'all classes' : one}
          </option>
        ))}
      </select>
      <label className="t-xs">
        <input
          type="checkbox"
          checked={props.refuses}
          onChange={(event) => props.setRefuses(event.target.checked)}
          data-mandate-refuses
        />{' '}
        Refusal
      </label>
    </>
  );
}

/** The filing the form's values make; null, with the first unset field focused, until all are set. */
function mandateOf(draft: {
  readonly label: string;
  readonly scope: string;
  readonly refuses: boolean;
  readonly labelRef: RefObject<HTMLInputElement | null>;
  readonly values: ReturnType<typeof useCeilingAndExpiry>;
}): MandateFiling | null {
  const { label, refuses, values } = draft;
  const cents = centsOf(values.ceiling);
  const expiresAt = expiryOf(values.expiry);
  const set = allSet([
    [label.trim() !== '', draft.labelRef],
    [refuses || cents !== null, values.ceilingRef],
    [expiresAt !== null, values.expiryRef],
  ]);
  if (!set || expiresAt === null) return null;
  const ceiling = refuses || cents === null ? null : { amountMinor: cents, currency: CURRENCY };
  return { classes: [draft.scope], refuses, ceiling, expiresAt, label: label.trim() };
}

export function MandateForm(props: {
  readonly scopes: readonly string[];
  readonly draft: MandateDraft;
  readonly edit: (change: MandateEdit) => void;
  readonly file: (mandate: MandateFiling, done: () => void) => void;
  readonly locked: boolean;
}): ReactElement {
  const { draft, edit } = props;
  const { label, refuses } = draft;
  const scope = props.scopes.includes(draft.scope) ? draft.scope : (props.scopes[0] ?? '');
  const setLabel = (value: string): void => edit({ label: value });
  const setScope = (value: string): void => edit({ scope: value });
  const setRefuses = (value: boolean): void => edit({ refuses: value });
  const labelRef = useRef<HTMLInputElement>(null);
  const values = useCeilingAndExpiry(draft, edit);
  const add = (): void => {
    const filing = mandateOf({ label, scope, refuses, labelRef, values });
    if (filing === null) return;
    props.file(filing, () => labelRef.current?.focus());
  };
  return (
    <div className="fieldrow psadd">
      <input
        ref={labelRef}
        className="connnote__field"
        type="text"
        placeholder="Write the rule the way you would say it out loud"
        aria-label="New standing approval sentence"
        value={label}
        disabled={props.locked}
        onChange={(event) => setLabel(event.target.value)}
        data-mandate-label
      />
      <ScopePicker scopes={props.scopes} {...{ scope, setScope, refuses, setRefuses }} />
      <CeilingAndExpiry what="" marks="mandate" noCeiling={refuses} {...values} />
      <button
        type="button"
        className="btn btn--sm btn--secondary"
        disabled={props.locked}
        onClick={add}
        data-mandate-add
      >
        Add
      </button>
    </div>
  );
}
