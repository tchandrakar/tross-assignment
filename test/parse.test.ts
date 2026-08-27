import { describe, expect, it } from 'vitest';
import { monthsBetween, parseDateCaption, parseDateRange, parseVectorImage, parseCountText } from '../src/linkedin/parse/common.js';
import { parseProfileView } from '../src/linkedin/parse/profile-view.js';
import profileViewFixture from './fixtures/profile-view.json' with { type: 'json' };

describe('date handling', () => {
  it('parses the legacy timePeriod shape', () => {
    const range = parseDateRange({ timePeriod: { startDate: { month: 3, year: 2020 }, endDate: { month: 6, year: 2022 } } });
    expect(range.start).toEqual({ day: null, month: 3, year: 2020 });
    expect(range.end).toEqual({ day: null, month: 6, year: 2022 });
    expect(range.current).toBe(false);
    expect(range.durationMonths).toBe(27);
  });

  it('treats a missing end date as current', () => {
    const range = parseDateRange({ timePeriod: { startDate: { month: 1, year: 2024 } } });
    expect(range.current).toBe(true);
    expect(range.end).toBeNull();
    expect(range.durationMonths).toBeGreaterThan(0);
  });

  it('parses dash caption text', () => {
    const range = parseDateCaption('Jan 2020 - Dec 2022 · 3 yrs');
    expect(range.start).toEqual({ day: null, month: 1, year: 2020 });
    expect(range.end).toEqual({ day: null, month: 12, year: 2022 });
    expect(range.current).toBe(false);
  });

  it('recognises "Present" in caption text', () => {
    const range = parseDateCaption('Mar 2021 - Present · 4 yrs 5 mos');
    expect(range.current).toBe(true);
    expect(range.end).toBeNull();
  });

  it('handles year-only captions', () => {
    expect(parseDateCaption('2018 - 2022').start).toEqual({ day: null, month: null, year: 2018 });
  });

  it('returns an empty range for unparseable text', () => {
    expect(parseDateCaption('sometime recently')).toEqual({ start: null, end: null, current: false, durationMonths: null });
  });

  it('computes months across a year boundary', () => {
    expect(monthsBetween({ day: null, month: 11, year: 2020 }, { day: null, month: 2, year: 2021 }, false)).toBe(3);
  });
});

describe('parseVectorImage', () => {
  it('selects the largest artifact and builds an absolute url', () => {
    const image = parseVectorImage({
      rootUrl: 'https://media.licdn.com/dms/image/abc/',
      artifacts: [
        { width: 100, height: 100, fileIdentifyingUrlPathSegment: 'small.jpg', expiresAt: 1767225600000 },
        { width: 800, height: 800, fileIdentifyingUrlPathSegment: 'large.jpg', expiresAt: 1767225600000 },
      ],
    });
    expect(image?.url).toBe('https://media.licdn.com/dms/image/abc/large.jpg');
    expect(image?.width).toBe(800);
    expect(image?.expiresAt).toBe(new Date(1767225600000).toISOString());
  });

  it('returns null when there are no artifacts', () => {
    expect(parseVectorImage({ rootUrl: 'https://x/' })).toBeNull();
    expect(parseVectorImage(null)).toBeNull();
  });
});

describe('parseCountText', () => {
  it.each([
    ['500+ connections', 500],
    ['1,234 followers', 1234],
    ['12K followers', 12000],
    ['1.5M followers', 1500000],
  ])('parses %s', (input, expected) => {
    expect(parseCountText(input)).toBe(expected);
  });
});

describe('parseProfileView', () => {
  const { profile, missingSections } = parseProfileView(profileViewFixture);

  it('extracts identity fields', () => {
    expect(profile.fullName).toBe('Ada Lovelace');
    expect(profile.headline).toBe('Mathematician | First Programmer');
    expect(profile.about).toContain('analytical engine');
    expect(profile.industry).toBe('Computer Software');
  });

  it('extracts location components', () => {
    expect(profile.location.full).toBe('London, England, United Kingdom');
    expect(profile.location.city).toBe('London');
    expect(profile.location.country).toBe('United Kingdom');
    expect(profile.location.countryCode).toBe('GB');
  });

  it('extracts experience with company metadata', () => {
    expect(profile.experience).toHaveLength(2);
    const [current] = profile.experience;
    expect(current?.title).toBe('Principal Engineer');
    expect(current?.company).toBe('Analytical Engines Ltd');
    expect(current?.companyLinkedinUrl).toBe('https://www.linkedin.com/company/analytical-engines/');
    expect(current?.dates.current).toBe(true);
    expect(current?.employmentType).toBe('Full time');
  });

  it('extracts education, skills, certifications and languages', () => {
    expect(profile.education[0]?.school).toBe('University of London');
    expect(profile.education[0]?.degree).toBe('BSc');
    expect(profile.skills.map((s) => s.name)).toEqual(['Mathematics', 'Algorithms']);
    expect(profile.certifications[0]?.credentialUrl).toBe('https://example.org/cert/1');
    expect(profile.languages[0]).toEqual({ name: 'English', proficiency: 'Native or bilingual proficiency' });
  });

  it('extracts the profile picture', () => {
    expect(profile.profilePicture?.url).toContain('large.jpg');
  });

  it('reports sections LinkedIn returned nothing for', () => {
    expect(missingSections).toContain('publication');
    expect(missingSections).not.toContain('position');
  });

  it('deduplicates skills case-insensitively', () => {
    const { profile: p } = parseProfileView({
      ...profileViewFixture,
      skillView: { elements: [{ name: 'Rust' }, { name: 'rust' }, { name: 'Go' }] },
    });
    expect(p.skills.map((s) => s.name)).toEqual(['Rust', 'Go']);
  });
});
