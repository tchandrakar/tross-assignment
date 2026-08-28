import { describe, expect, it } from 'vitest';
import { extractLdJson, findPerson, isMasked, parsePublicProfile } from '../src/linkedin/parse/public-profile.js';

/** Shaped exactly like a real logged-out profile page, masking included. */
const page = (person: Record<string, unknown>) =>
  `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'http://schema.org',
    '@graph': [{ '@type': 'WebPage', url: 'https://www.linkedin.com/in/x' }, { '@type': 'Person', ...person }],
  })}</script></head><body></body></html>`;

describe('isMasked', () => {
  it('recognises LinkedIn masking logged-out text', () => {
    expect(isMasked('*** ******* ******* * *********')).toBe(true);
    expect(isMasked('***')).toBe(true);
  });

  it('does not flag ordinary text', () => {
    expect(isMasked('Chair, Gates Foundation')).toBe(false);
    expect(isMasked('Harvard University')).toBe(false);
  });

  it('keeps partly-masked strings, which still carry information', () => {
    expect(isMasked('Confidential (In stealth mode)')).toBe(false);
  });

  it('handles non-strings and empties', () => {
    expect(isMasked(null)).toBe(false);
    expect(isMasked('')).toBe(false);
    expect(isMasked(42)).toBe(false);
  });
});

describe('extractLdJson / findPerson', () => {
  it('finds the Person inside an @graph', () => {
    const person = findPerson(extractLdJson(page({ name: 'Ada Lovelace' })));
    expect(person?.name).toBe('Ada Lovelace');
  });

  it('returns null when the page has no Person', () => {
    expect(findPerson(extractLdJson('<html><body>nothing</body></html>'))).toBeNull();
  });

  it('skips malformed blocks instead of throwing', () => {
    const html = '<script type="application/ld+json">{not json}</script>' + page({ name: 'Ada' });
    expect(findPerson(extractLdJson(html))?.name).toBe('Ada');
  });
});

describe('parsePublicProfile', () => {
  const parsed = parsePublicProfile(
    page({
      name: 'Jaymin K.',
      jobTitle: ['*** ******* ******* * *********', '**** ****** *********'],
      address: { addressLocality: 'Ahmedabad', addressRegion: 'Gujarat', addressCountry: 'India' },
      image: { '@type': 'ImageObject', contentUrl: 'https://media.licdn.com/x.jpg' },
      worksFor: [
        { '@type': 'Organization', name: 'Confidential (In stealth mode)', location: 'Ahmedabad',
          member: { startDate: 2015, endDate: 2016, description: '*********** *** ********' } },
        { '@type': 'Organization', name: '***', location: 'Ahmedabad', member: { startDate: 2013, endDate: 2015 } },
      ],
      alumniOf: [{ '@type': 'EducationalOrganization', name: 'Nirma University', member: { startDate: 2008, endDate: 2011 } }],
      knowsLanguage: [{ name: 'English' }, { name: 'Gujarati' }],
      awards: ['Employee of the Month'],
      interactionStatistic: [
        { '@type': 'InteractionCounter', interactionType: 'https://schema.org/FollowAction', userInteractionCount: 1234 },
      ],
    }),
  )!;

  it('extracts the fields LinkedIn leaves visible', () => {
    expect(parsed.profile.fullName).toBe('Jaymin K.');
    expect(parsed.profile.location.city).toBe('Ahmedabad');
    expect(parsed.profile.location.full).toBe('Ahmedabad, Gujarat, India');
    expect(parsed.profile.followerCount).toBe(1234);
    expect(parsed.profile.profilePicture?.url).toBe('https://media.licdn.com/x.jpg');
  });

  it('reports masked values as null rather than returning asterisks', () => {
    // Returning "*** ******* *******" would be worse than returning nothing:
    // a consumer would store it as the member's actual job title.
    expect(parsed.profile.headline).toBeNull();
    expect(parsed.profile.experience[1]?.company).toBeNull();
    expect(parsed.profile.experience[0]?.description).toBeNull();
  });

  it('keeps company names that are not masked', () => {
    expect(parsed.profile.experience[0]?.company).toBe('Confidential (In stealth mode)');
  });

  it('records which fields were masked, so degraded data is identifiable', () => {
    expect(parsed.maskedFields).toContain('headline');
    expect(parsed.maskedFields).toContain('experience[1].company');
  });

  it('extracts languages and awards, which are not masked', () => {
    expect(parsed.profile.languages.map((l) => l.name)).toEqual(['English', 'Gujarati']);
    expect(parsed.profile.honors[0]?.title).toBe('Employee of the Month');
  });

  it('extracts year-precision date ranges', () => {
    expect(parsed.profile.experience[0]?.dates.start).toEqual({ day: null, month: null, year: 2015 });
    expect(parsed.profile.experience[0]?.dates.end).toEqual({ day: null, month: null, year: 2016 });
    expect(parsed.profile.education[0]?.dates.start?.year).toBe(2008);
  });

  it('lists sections the public page never carries', () => {
    for (const section of ['skills', 'certifications', 'projects', 'publications', 'volunteering']) {
      expect(parsed.missingSections).toContain(section);
    }
  });

  it('reports about as null — it is not exposed to logged-out viewers at all', () => {
    expect(parsed.profile.about).toBeNull();
  });

  it('returns null for a page with no structured data', () => {
    expect(parsePublicProfile('<html><body>nope</body></html>')).toBeNull();
  });
});
