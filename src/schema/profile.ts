import { z } from 'zod';

/**
 * The public response contract. The brief leaves the schema to us, so the
 * design goals here are:
 *   - stable key names that don't leak LinkedIn's internal vocabulary (no URNs
 *     in required fields, no `com.linkedin.voyager.*` recipe types)
 *   - `null` for "we looked and it isn't there", omitted for "not applicable"
 *   - dates as structured {month, year} rather than pre-formatted strings,
 *     because LinkedIn genuinely only has that precision and formatting is the
 *     caller's business
 *   - every list always present (possibly empty) so callers never branch on
 *     undefined
 */

export const dateSchema = z
  .object({
    day: z.number().int().min(1).max(31).nullable().default(null),
    month: z.number().int().min(1).max(12).nullable().default(null),
    year: z.number().int().min(1900).max(2200).nullable().default(null),
  })
  .describe('Partial date. LinkedIn frequently exposes only month+year, or only year.');

export const dateRangeSchema = z.object({
  start: dateSchema.nullable().default(null),
  end: dateSchema.nullable().default(null),
  /** True when LinkedIn marks the entry as ongoing ("Present"). */
  current: z.boolean().default(false),
  /** Total span in months, computed by us — null when the start date is unknown. */
  durationMonths: z.number().int().nonnegative().nullable().default(null),
});

export const imageSchema = z.object({
  url: z.string(),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  /**
   * LinkedIn media URLs are signed and expire (typically ~30 days). Callers
   * that need permanence must re-host the bytes.
   */
  expiresAt: z.string().datetime().nullable().default(null),
});

export const locationSchema = z.object({
  full: z.string().nullable().default(null),
  city: z.string().nullable().default(null),
  country: z.string().nullable().default(null),
  countryCode: z.string().length(2).nullable().default(null),
});

export const experienceSchema = z.object({
  title: z.string().nullable().default(null),
  employmentType: z.string().nullable().default(null),
  company: z.string().nullable().default(null),
  companyLinkedinUrl: z.string().nullable().default(null),
  companyLogo: imageSchema.nullable().default(null),
  location: z.string().nullable().default(null),
  /** "On-site" | "Remote" | "Hybrid" as LinkedIn labels it. */
  workplaceType: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  dates: dateRangeSchema,
  skills: z.array(z.string()).default([]),
});

export const educationSchema = z.object({
  school: z.string().nullable().default(null),
  schoolLinkedinUrl: z.string().nullable().default(null),
  schoolLogo: imageSchema.nullable().default(null),
  degree: z.string().nullable().default(null),
  fieldOfStudy: z.string().nullable().default(null),
  grade: z.string().nullable().default(null),
  activities: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  dates: dateRangeSchema,
});

export const skillSchema = z.object({
  name: z.string(),
  endorsementCount: z.number().int().nonnegative().nullable().default(null),
});

export const certificationSchema = z.object({
  name: z.string().nullable().default(null),
  issuer: z.string().nullable().default(null),
  issuerLogo: imageSchema.nullable().default(null),
  issuedAt: dateSchema.nullable().default(null),
  expiresAt: dateSchema.nullable().default(null),
  credentialId: z.string().nullable().default(null),
  credentialUrl: z.string().nullable().default(null),
});

export const languageSchema = z.object({
  name: z.string(),
  /** LinkedIn's own label, e.g. "Native or bilingual proficiency". */
  proficiency: z.string().nullable().default(null),
});

export const projectSchema = z.object({
  name: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  dates: dateRangeSchema,
});

export const publicationSchema = z.object({
  title: z.string().nullable().default(null),
  publisher: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  publishedAt: dateSchema.nullable().default(null),
});

export const honorSchema = z.object({
  title: z.string().nullable().default(null),
  issuer: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  issuedAt: dateSchema.nullable().default(null),
});

export const volunteerSchema = z.object({
  role: z.string().nullable().default(null),
  organization: z.string().nullable().default(null),
  cause: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  dates: dateRangeSchema,
});

export const profileSchema = z.object({
  /** The /in/<publicId> identifier. Stable per profile unless the member changes it. */
  publicId: z.string(),
  profileUrl: z.string(),
  /** LinkedIn's internal member URN. Opaque, but stable across vanity-name changes. */
  urn: z.string().nullable().default(null),

  firstName: z.string().nullable().default(null),
  lastName: z.string().nullable().default(null),
  fullName: z.string().nullable().default(null),
  headline: z.string().nullable().default(null),
  about: z.string().nullable().default(null),
  location: locationSchema.default({}),
  industry: z.string().nullable().default(null),
  pronouns: z.string().nullable().default(null),

  connectionCount: z.number().int().nonnegative().nullable().default(null),
  followerCount: z.number().int().nonnegative().nullable().default(null),

  isPremium: z.boolean().default(false),
  isInfluencer: z.boolean().default(false),
  isOpenToWork: z.boolean().default(false),
  isHiring: z.boolean().default(false),

  profilePicture: imageSchema.nullable().default(null),
  backgroundImage: imageSchema.nullable().default(null),

  experience: z.array(experienceSchema).default([]),
  education: z.array(educationSchema).default([]),
  skills: z.array(skillSchema).default([]),
  certifications: z.array(certificationSchema).default([]),
  languages: z.array(languageSchema).default([]),
  projects: z.array(projectSchema).default([]),
  publications: z.array(publicationSchema).default([]),
  honors: z.array(honorSchema).default([]),
  volunteering: z.array(volunteerSchema).default([]),
});

export const sourceSchema = z.enum([
  /** The dash profile graph — one request returns the whole profile. */
  'voyager-dash',
  /** Legacy REST profile view. Withdrawn upstream; retained as a fallback. */
  'voyager-profile-view',
  /**
   * The public profile page, read without a session. Substantially reduced:
   * LinkedIn masks most free text for logged-out viewers. Reported so a
   * consumer can tell degraded data from complete data.
   */
  'public',
  /** Served from the cache without contacting LinkedIn. */
  'cache',
]);

export const metaSchema = z.object({
  /** Whether this response was served from the blob cache without touching LinkedIn. */
  cached: z.boolean(),
  /** Which strategy produced the data (the original one, if served from cache). */
  source: sourceSchema,
  /** When the underlying scrape actually happened. */
  scrapedAt: z.string().datetime(),
  /** Age of the cached copy in seconds. 0 for a fresh scrape. */
  ageSeconds: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  /** Sections LinkedIn returned nothing for — distinguishes "empty" from "failed". */
  missingSections: z.array(z.string()).default([]),
});

export const profileResponseSchema = z.object({
  success: z.literal(true),
  data: profileSchema,
  meta: metaSchema,
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
    retryAfterSeconds: z.number().optional(),
  }),
});

export type Profile = z.infer<typeof profileSchema>;
export type ProfileMeta = z.infer<typeof metaSchema>;
export type ScrapeSource = z.infer<typeof sourceSchema>;
export type Experience = z.infer<typeof experienceSchema>;
export type Education = z.infer<typeof educationSchema>;
export type LinkedinImage = z.infer<typeof imageSchema>;
export type PartialDate = z.infer<typeof dateSchema>;
export type DateRange = z.infer<typeof dateRangeSchema>;
