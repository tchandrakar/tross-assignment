import { describe, expect, it } from 'vitest';
import { parseProfileUrl } from '../src/linkedin/url.js';
import { ApiError } from '../src/errors.js';

describe('parseProfileUrl', () => {
  it.each([
    ['https://www.linkedin.com/in/john-doe-123/', 'john-doe-123'],
    ['https://linkedin.com/in/john-doe-123', 'john-doe-123'],
    ['http://www.linkedin.com/in/john-doe-123', 'john-doe-123'],
    ['linkedin.com/in/john-doe-123', 'john-doe-123'],
    ['www.linkedin.com/in/john-doe-123/', 'john-doe-123'],
    ['https://in.linkedin.com/in/john-doe-123?originalSubdomain=in', 'john-doe-123'],
    ['https://www.linkedin.com/in/john-doe-123/en', 'john-doe-123'],
    ['https://www.linkedin.com/in/john-doe-123/detail/recent-activity/', 'john-doe-123'],
    ['https://www.linkedin.com/in/John-Doe-123/', 'john-doe-123'],
    ['john-doe-123', 'john-doe-123'],
  ])('parses %s', (input, expected) => {
    expect(parseProfileUrl(input).publicId).toBe(expected);
  });

  it('percent-decodes non-ascii vanity names', () => {
    expect(parseProfileUrl('https://www.linkedin.com/in/%E5%B1%B1%E7%94%B0%E5%A4%AA%E9%83%8E/').publicId)
      .toBe('山田太郎');
  });

  it('produces a canonical url', () => {
    expect(parseProfileUrl('linkedin.com/in/John-Doe/').canonicalUrl)
      .toBe('https://www.linkedin.com/in/john-doe/');
  });

  it.each([
    ['', 'empty input'],
    ['https://www.linkedin.com/company/google/', 'company url'],
    ['https://www.linkedin.com/school/mit/', 'school url'],
    ['https://www.linkedin.com/feed/', 'non-profile path'],
    ['https://twitter.com/in/john-doe', 'wrong host'],
    ['https://www.linkedin.com/in/', 'missing identifier'],
    ['https://evil.com/www.linkedin.com/in/john', 'host smuggling'],
  ])('rejects %s (%s)', (input) => {
    expect(() => parseProfileUrl(input)).toThrow(ApiError);
  });

  it('rejects a linkedin lookalike domain', () => {
    expect(() => parseProfileUrl('https://linkedin.com.evil.com/in/john')).toThrow(/host/i);
  });
});
