import type { DateRange, LinkedinImage, PartialDate } from '../../schema/profile.js';

/** Shared value extraction. Voyager is inconsistent, so every getter is defensive. */

type Json = unknown;
export interface JsonObject { [key: string]: Json }

export const isObject = (v: Json): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function str(v: Json): string | null {
  if (typeof v === 'string') {
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof v === 'number') return String(v);
  return null;
}

export function num(v: Json): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const parsed = Number(v.replace(/[,\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function bool(v: Json): boolean {
  return v === true;
}

/**
 * Legacy Voyager encodes union types as a single-key wrapper whose key is the
 * fully-qualified type name:
 *
 *   "picture": { "com.linkedin.common.VectorImage": { rootUrl, artifacts } }
 *
 * Callers never care which union arm was selected, and the dots in the key
 * would otherwise collide with dotted path syntax. Unwrap transparently.
 */
export function unwrapUnion(value: Json): Json {
  if (!isObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length !== 1) return value;
  const only = keys[0]!;
  if (!only.startsWith('com.linkedin.')) return value;
  return value[only];
}

/** Safe nested access: get(obj, 'a.b.0.c'). Union wrappers are stepped through. */
export function get(root: Json, path: string): Json {
  let current: Json = unwrapUnion(root);
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      const idx = Number(segment);
      current = Number.isInteger(idx) ? current[idx] : undefined;
    } else if (isObject(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
    if (current === undefined || current === null) return current ?? undefined;
    current = unwrapUnion(current);
  }
  return current;
}

/** First non-null result across several candidate paths. */
export function pick(root: Json, ...paths: string[]): Json {
  for (const path of paths) {
    const value = get(root, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

export function arr(v: Json): JsonObject[] {
  return Array.isArray(v) ? v.filter(isObject) : [];
}

/**
 * LinkedIn wraps most display strings in an "attributed text" envelope that
 * also carries entity annotations. We only want the text.
 */
export function attributedText(v: Json): string | null {
  if (typeof v === 'string') return str(v);
  if (!isObject(v)) return null;
  return str(v.text) ?? str(get(v, 'attributedText.text')) ?? null;
}

// ─── Dates ───────────────────────────────────────────────────────────────────

export function parseDate(v: Json): PartialDate | null {
  if (!isObject(v)) return null;
  const year = num(v.year);
  const month = num(v.month);
  const day = num(v.day);
  if (year === null && month === null && day === null) return null;
  return { day, month, year };
}

/**
 * Parses the two date shapes Voyager uses:
 *   legacy: { timePeriod: { startDate, endDate } }
 *   dash:   { dateRange: { start, end } }
 * plus the free-text "Jan 2020 - Present · 3 yrs" caption seen on newer cards.
 */
export function parseDateRange(v: Json): DateRange {
  const container = pick(v, 'timePeriod', 'dateRange') ?? v;

  const start = parseDate(pick(container, 'startDate', 'start'));
  const end = parseDate(pick(container, 'endDate', 'end'));

  const explicitCurrent = get(v, 'currentRoleItem') !== undefined || bool(get(container, 'current'));
  const current = end === null && (start !== null || explicitCurrent);

  return {
    start,
    end,
    current,
    durationMonths: monthsBetween(start, end, current),
  };
}

export function monthsBetween(start: PartialDate | null, end: PartialDate | null, current: boolean): number | null {
  if (!start?.year) return null;

  const startMonths = start.year * 12 + (start.month ?? 1) - 1;

  let endMonths: number;
  if (end?.year) {
    endMonths = end.year * 12 + (end.month ?? 12) - 1;
  } else if (current) {
    const now = new Date();
    endMonths = now.getUTCFullYear() * 12 + now.getUTCMonth();
  } else {
    return null;
  }

  return Math.max(0, endMonths - startMonths);
}

/** Parses "Jan 2020 - Present · 3 yrs 2 mos" style captions from dash cards. */
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export function parseDateCaption(caption: string | null): DateRange {
  const empty: DateRange = { start: null, end: null, current: false, durationMonths: null };
  if (!caption) return empty;

  const [rangePart] = caption.split('·');
  if (!rangePart) return empty;

  const [rawStart, rawEnd] = rangePart.split(/\s+[-–—]\s+/).map((s) => s?.trim() ?? '');
  const start = parseTextDate(rawStart);
  const current = /present|current/i.test(rawEnd ?? '');
  const end = current ? null : parseTextDate(rawEnd);

  if (!start && !end) return empty;
  return { start, end, current, durationMonths: monthsBetween(start, end, current) };
}

function parseTextDate(text: string | undefined): PartialDate | null {
  if (!text) return null;
  const match = /(?:([A-Za-z]{3,})\s+)?(\d{4})/.exec(text);
  if (!match) return null;
  const monthName = match[1]?.slice(0, 3).toLowerCase();
  return {
    day: null,
    month: monthName ? (MONTHS[monthName] ?? null) : null,
    year: Number(match[2]),
  };
}

// ─── Media ───────────────────────────────────────────────────────────────────

/**
 * LinkedIn images arrive as a `VectorImage`: a rootUrl plus per-size artifacts
 * whose path segments are individually signed and expiring. We pick the largest
 * artifact and reassemble the absolute URL.
 */
export function parseVectorImage(v: Json): LinkedinImage | null {
  const unwrapped = unwrapUnion(v);
  if (!isObject(unwrapped)) return null;

  const vector =
    typeof unwrapped.rootUrl === 'string'
      ? unwrapped
      : (pick(
          unwrapped,
          'vectorImage',
          'image',
          'displayImageReference.vectorImage',
          'attributes.0.detailData.nonEntityProfilePicture.vectorImage',
          'attributes.0.detailData.vectorImage',
        ) as Json);

  if (!isObject(vector)) return null;

  const rootUrl = str(vector.rootUrl);
  const artifacts = arr(vector.artifacts);
  if (!rootUrl || artifacts.length === 0) return null;

  const largest = artifacts.reduce((best, candidate) => {
    const bestW = num(best.width) ?? 0;
    const candidateW = num(candidate.width) ?? 0;
    return candidateW > bestW ? candidate : best;
  }, artifacts[0]!);

  const segment = str(largest.fileIdentifyingUrlPathSegment);
  if (!segment) return null;

  const expiresAtMs = num(largest.expiresAt);

  return {
    url: `${rootUrl}${segment}`,
    width: num(largest.width),
    height: num(largest.height),
    expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
  };
}

// ─── Misc ────────────────────────────────────────────────────────────────────

export function companyUrlFromUniversalName(universalName: Json): string | null {
  const name = str(universalName);
  return name ? `https://www.linkedin.com/company/${name}/` : null;
}

export function schoolUrlFromUniversalName(universalName: Json): string | null {
  const name = str(universalName);
  return name ? `https://www.linkedin.com/school/${name}/` : null;
}

/** Turns "500+ connections" / "1,234 followers" into a number. */
export function parseCountText(v: Json): number | null {
  const text = str(v);
  if (!text) return null;
  const match = /([\d,.]+)\s*([KkMm])?/.exec(text);
  if (!match) return null;
  const base = Number(match[1]!.replace(/[,\s]/g, ''));
  if (!Number.isFinite(base)) return null;
  const suffix = match[2]?.toLowerCase();
  if (suffix === 'k') return Math.round(base * 1_000);
  if (suffix === 'm') return Math.round(base * 1_000_000);
  return Math.round(base);
}

export function dedupe<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (!k || seen.has(k)) return k ? false : true;
    seen.add(k);
    return true;
  });
}
