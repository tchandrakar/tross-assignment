import { describe, expect, it } from 'vitest';
import { normalize, resolveGraph, buildIndex } from '../src/linkedin/normalize.js';

describe('normalize', () => {
  it('rehydrates a single urn reference', () => {
    const body = {
      data: { '*profile': 'urn:li:fsd_profile:ABC', other: 1 },
      included: [{ entityUrn: 'urn:li:fsd_profile:ABC', firstName: 'Ada' }],
    };
    const { data } = normalize(body);
    expect(data).toMatchObject({
      profile: { firstName: 'Ada' },
      profileUrn: 'urn:li:fsd_profile:ABC',
      other: 1,
    });
  });

  it('rehydrates arrays of urns in order', () => {
    const body = {
      data: { '*elements': ['urn:a', 'urn:b'] },
      included: [
        { entityUrn: 'urn:b', name: 'B' },
        { entityUrn: 'urn:a', name: 'A' },
      ],
    };
    const { data } = normalize(body) as { data: { elements: Array<{ name: string }> } };
    expect(data.elements.map((e) => e.name)).toEqual(['A', 'B']);
  });

  it('yields null for a dangling reference rather than throwing', () => {
    const { data } = normalize({ data: { '*missing': 'urn:nope' }, included: [] });
    expect(data).toMatchObject({ missing: null, missingUrn: 'urn:nope' });
  });

  it('breaks reference cycles', () => {
    const index = buildIndex([
      { entityUrn: 'urn:a', '*peer': 'urn:b' },
      { entityUrn: 'urn:b', '*peer': 'urn:a' },
    ]);
    const resolved = resolveGraph({ '*root': 'urn:a' }, index) as Record<string, any>;
    expect(resolved.root.peer.peer).toMatchObject({ $circular: true });
  });

  it('tolerates a body with no included array', () => {
    expect(() => normalize({ data: { a: 1 } })).not.toThrow();
    expect(() => normalize(null)).not.toThrow();
  });
});
