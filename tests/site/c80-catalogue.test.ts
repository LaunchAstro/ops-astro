// SPDX-License-Identifier: AGPL-3.0-only
//
// C80: the six operations of the release decision's section 3.1, each
// registered with all twelve declarations, and a registration missing one
// refuses. The strictest-default rule means nothing registers by omission.

import { describe, expect, it } from 'vitest';
import {
  DECLARATION_NAMES,
  SITE_OPERATIONS,
  connectorRelease,
  registerOperation,
  siteCatalogue,
  type OperationRegistration,
} from '../../packages/core-connectors/src/index.ts';

const NAMES = [
  'site.source.read',
  'site.source.propose',
  'site.publish',
  'site.source.revert',
  'site.deployment.read',
  'site.capture',
];

function registration(name: string): OperationRegistration {
  const found = SITE_OPERATIONS.find((entry) => entry.declaration.operation_name === name);
  if (found === undefined) throw new Error(`no operation ${name}`);
  return structuredClone(found);
}

describe('C80 twelve declarations', () => {
  it('registers exactly the six catalogued operations, each declaring all twelve', () => {
    const catalogue = siteCatalogue();
    expect(catalogue.ok).toBe(true);
    if (!catalogue.ok) return;
    expect(catalogue.value.map((entry) => entry.operation_name).toSorted()).toEqual(
      NAMES.toSorted(),
    );
    for (const entry of catalogue.value) {
      expect(Object.keys(entry).toSorted()).toEqual([...DECLARATION_NAMES].toSorted());
    }
    expect(DECLARATION_NAMES).toHaveLength(12);
  });

  it.each(DECLARATION_NAMES)('refuses a registration missing %s', (missing) => {
    for (const name of NAMES) {
      const candidate = registration(name) as unknown as {
        declaration: Record<string, unknown>;
      };
      delete candidate.declaration[missing];
      const result = registerOperation(candidate);
      expect(result).toEqual({
        ok: false,
        code: 'OPERATION_DECLARATION_MISSING',
        fields: [missing],
      });
    }
  });

  it('refuses a declaration present but undefined, as missing rather than defaulted', () => {
    const candidate = registration('site.publish') as unknown as {
      declaration: Record<string, unknown>;
    };
    candidate.declaration['reconcile_mode'] = undefined;
    expect(registerOperation(candidate)).toMatchObject({
      code: 'OPERATION_DECLARATION_MISSING',
      fields: ['reconcile_mode'],
    });
  });

  it('refuses an undeclared thirteenth field rather than ignoring it', () => {
    const candidate = registration('site.capture') as unknown as {
      declaration: Record<string, unknown>;
    };
    candidate.declaration['credential'] = 'anything';
    expect(registerOperation(candidate)).toMatchObject({
      code: 'OPERATION_DECLARATION_INVALID',
      fields: ['credential'],
    });
  });

  it('refuses values outside each declaration, including case and spacing variants', () => {
    const cases: [string, unknown][] = [
      ['effect_class', 'Reversible'],
      ['effect_class', 'reversible '],
      ['reversibility_strategy', 'R6'],
      ['reconcile_mode', 'neither'],
      ['acknowledgement_semantics', 'live'],
      ['credential_tier', 'T4'],
      ['trust_class', 'prohibited'],
      ['trust_class', 'arbitrary_executable'],
      ['data_flow_labels', 'public'],
      ['nothing_happened_proof', 'none'],
      ['quota_class', { bucket: 'x' }],
    ];
    for (const [field, value] of cases) {
      const candidate = registration('site.source.propose') as unknown as {
        declaration: Record<string, unknown>;
      };
      candidate.declaration[field] = value;
      expect(registerOperation(candidate), `${field}=${JSON.stringify(value)}`).toMatchObject({
        ok: false,
        code: 'OPERATION_DECLARATION_INVALID',
        fields: [field],
      });
    }
  });

  it('refuses a reconcilable operation with no seam held before dispatch', () => {
    const candidate = registration('site.publish');
    const mutable = candidate as unknown as { declaration: Record<string, unknown> };
    mutable.declaration['reconcile_seam'] = {
      read_operation: 'site.deployment.read',
      reference: '',
    };
    expect(registerOperation(candidate)).toMatchObject({
      code: 'OPERATION_DECLARATION_INVALID',
      fields: ['reconcile_seam'],
    });
  });

  it('refuses a connector release that is not the digest of the connector definition it registers', () => {
    const candidate = registration('site.source.read');
    const moved = { ...candidate, connector: { ...candidate.connector, method: 'POST' as const } };
    expect(registerOperation(moved)).toMatchObject({
      code: 'CONNECTOR_RELEASE_MISMATCH',
      fields: ['connector_release'],
    });
    expect(connectorRelease(candidate.connector)).toBe(candidate.declaration.connector_release);
  });

  it('refuses a connector whose credential belongs to another host, even with a matching release', () => {
    const candidate = registration('site.publish');
    const connector = { ...candidate.connector, host: 'api.vercel.com' };
    const crossed = {
      connector,
      declaration: { ...candidate.declaration, connector_release: connectorRelease(connector) },
    };
    expect(registerOperation(crossed)).toMatchObject({
      code: 'OPERATION_DECLARATION_INVALID',
      fields: ['credential_tier'],
    });
  });

  it('keeps publish at R2 and accepted only, and capture with no credential at all', () => {
    const publish = registration('site.publish').declaration;
    expect(publish.reversibility_strategy).toBe('R2');
    expect(publish.acknowledgement_semantics).toBe('accepted');
    expect(registration('site.deployment.read').declaration.acknowledgement_semantics).toBe(
      'landed',
    );
    expect(registration('site.capture').declaration.credential_tier).toBe('none');
    expect(registration('site.capture').connector.credential).toBe('none');
  });

  it('refuses a second registration of a name already in the catalogue', () => {
    const doubled = [...SITE_OPERATIONS, registration('site.capture')];
    expect(siteCatalogue(doubled)).toMatchObject({
      ok: false,
      code: 'OPERATION_ALREADY_REGISTERED',
      fields: ['site.capture'],
    });
  });

  it('refuses a catalogue that offers a DNS operation, which is not on this path (D21-1)', () => {
    const dns = registration('site.deployment.read');
    const renamed = {
      ...dns,
      declaration: { ...dns.declaration, operation_name: 'dns.record.write' },
    };
    expect(siteCatalogue([...SITE_OPERATIONS, renamed])).toMatchObject({
      ok: false,
      code: 'OPERATION_NOT_ON_PATH',
      fields: ['dns.record.write'],
    });
  });
});
