import {
  arr, attributedText, isObject, parseCountText, parseDateCaption, parseVectorImage,
  pick, str, type JsonObject,
} from './common.js';
import type { DateRange, LinkedinImage } from '../../schema/profile.js';

/**
 * Parser for the modern GraphQL "profile cards" surface
 * (`voyagerIdentityDashProfileComponents`).
 *
 * Unlike profileView, this endpoint returns *rendering instructions* rather
 * than data: every section is a tree of generic UI components, and the semantic
 * meaning of a field is positional. A position looks like
 *
 *   entityComponent
 *     titleV2  → "Senior Software Engineer"
 *     subtitle → "Google · Full-time"
 *     caption  → "Jan 2020 - Present · 3 yrs 2 mos"
 *     metadata → "Bengaluru, India · Hybrid"
 *     subComponents → description, bullet lists, nested roles
 *
 * So the parser's job is to flatten that tree into entity records, then apply
 * per-section interpretation of what title/subtitle/caption *mean*. It is
 * strictly worse than profileView — hence the fallback ordering — but it is
 * what LinkedIn's own web client uses, so it keeps working when the legacy
 * endpoint is disabled for an account.
 */

export interface CardEntity {
  title: string | null;
  subtitle: string | null;
  caption: string | null;
  metadata: string | null;
  image: LinkedinImage | null;
  link: string | null;
  /** Free text found in subComponents — descriptions, bullet lists, skill chips. */
  texts: string[];
  /** Nested entities, e.g. multiple roles at one company. */
  children: CardEntity[];
}

const MAX_WALK_DEPTH = 12;

/** Depth-first collection of every entityComponent in a card tree, in order. */
export function collectEntities(node: unknown, depth = 0): CardEntity[] {
  if (depth > MAX_WALK_DEPTH) return [];

  if (Array.isArray(node)) {
    return node.flatMap((child) => collectEntities(child, depth + 1));
  }
  if (!isObject(node)) return [];

  const entity = node.entityComponent;
  if (isObject(entity)) {
    return [readEntity(entity, depth)];
  }

  return Object.values(node).flatMap((child) => collectEntities(child, depth + 1));
}

function readEntity(entity: JsonObject, depth: number): CardEntity {
  const sub = entity.subComponents;

  return {
    title: attributedText(pick(entity, 'titleV2.text', 'titleV2', 'title')),
    subtitle: attributedText(pick(entity, 'subtitle.text', 'subtitle')),
    caption: attributedText(pick(entity, 'caption.text', 'caption')),
    metadata: attributedText(pick(entity, 'metadata.text', 'metadata')),
    image: parseVectorImage(
      pick(
        entity,
        'image.attributes.0.detailData.companyLogo.logo',
        'image.attributes.0.detailData.schoolLogo.logo',
        'image.attributes.0.detailData.nonEntityCompanyLogo',
        'image.attributes.0.detailData.nonEntitySchoolLogo',
        'image.attributes.0.detailData.nonEntityProfilePicture',
        'image.attributes.0.detailData',
        'image',
      ),
    ),
    link: str(pick(entity, 'textActionTarget', 'navigationUrl', 'image.actionTarget')),
    texts: sub ? collectTexts(sub, 0) : [],
    children: sub ? collectNestedEntities(sub, depth + 1) : [],
  };
}

/** Nested entityComponents (multi-role companies) live one level down in subComponents. */
function collectNestedEntities(node: unknown, depth: number): CardEntity[] {
  if (depth > MAX_WALK_DEPTH) return [];
  if (Array.isArray(node)) return node.flatMap((c) => collectNestedEntities(c, depth + 1));
  if (!isObject(node)) return [];
  if (isObject(node.entityComponent)) return [readEntity(node.entityComponent, depth)];
  return Object.values(node).flatMap((c) => collectNestedEntities(c, depth + 1));
}

function collectTexts(node: unknown, depth: number): string[] {
  if (depth > MAX_WALK_DEPTH) return [];
  if (Array.isArray(node)) return node.flatMap((c) => collectTexts(c, depth + 1));
  if (!isObject(node)) return [];

  // Don't descend into nested entities — their text belongs to them.
  if (isObject(node.entityComponent)) return [];

  const out: string[] = [];
  const direct = node.textComponent ?? node.fixedListComponent;
  if (isObject(node.textComponent)) {
    const text = attributedText(pick(node.textComponent, 'text', 'text.text'));
    if (text) out.push(text);
  }
  void direct;

  for (const value of Object.values(node)) {
    out.push(...collectTexts(value, depth + 1));
  }
  return out;
}

// ─── Section interpreters ────────────────────────────────────────────────────

/**
 * "Google · Full-time" → { company: "Google", employmentType: "Full-time" }
 * The separator is a middot; LinkedIn also uses it in metadata.
 */
export function splitBullets(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(/\s*·\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function entityToExperience(entity: CardEntity) {
  const [company, employmentType] = splitBullets(entity.subtitle);
  const [location, workplaceType] = splitBullets(entity.metadata);

  return {
    title: entity.title,
    employmentType: employmentType ?? null,
    company: company ?? null,
    companyLinkedinUrl: normaliseCompanyLink(entity.link),
    companyLogo: entity.image,
    location: location ?? null,
    workplaceType: workplaceType ?? null,
    description: entity.texts.join('\n\n') || null,
    dates: parseDateCaption(entity.caption),
    skills: [] as string[],
  };
}

export function entityToEducation(entity: CardEntity) {
  // Education subtitle carries "Bachelor of Technology, Computer Science".
  const [degree, fieldOfStudy] = (entity.subtitle ?? '').split(/\s*,\s*/, 2);

  return {
    school: entity.title,
    schoolLinkedinUrl: normaliseCompanyLink(entity.link),
    schoolLogo: entity.image,
    degree: degree?.trim() || null,
    fieldOfStudy: fieldOfStudy?.trim() || null,
    grade: entity.texts.find((t) => /^grade[:\s]/i.test(t))?.replace(/^grade[:\s]*/i, '') ?? null,
    activities: entity.texts.find((t) => /^activities/i.test(t)) ?? null,
    description: entity.texts.filter((t) => !/^(grade|activities)/i.test(t)).join('\n\n') || null,
    dates: parseDateCaption(entity.caption),
  };
}

export function entityToSkill(entity: CardEntity) {
  const endorsement = entity.texts.find((t) => /endorsement/i.test(t));
  return {
    name: entity.title ?? '',
    endorsementCount: endorsement ? parseCountText(endorsement) : null,
  };
}

export function entityToCertification(entity: CardEntity) {
  const credentialText = entity.texts.find((t) => /credential id/i.test(t));
  return {
    name: entity.title,
    issuer: entity.subtitle,
    issuerLogo: entity.image,
    issuedAt: parseDateCaption(entity.caption).start,
    expiresAt: parseDateCaption(entity.caption).end,
    credentialId: credentialText?.replace(/.*credential id[:\s]*/i, '').trim() || null,
    credentialUrl: entity.link,
  };
}

export function entityToLanguage(entity: CardEntity) {
  return { name: entity.title ?? '', proficiency: entity.caption ?? entity.subtitle };
}

export function entityToProject(entity: CardEntity) {
  return {
    name: entity.title,
    description: entity.texts.join('\n\n') || null,
    url: entity.link,
    dates: parseDateCaption(entity.caption),
  };
}

export function entityToHonor(entity: CardEntity) {
  return {
    title: entity.title,
    issuer: entity.subtitle,
    description: entity.texts.join('\n\n') || null,
    issuedAt: parseDateCaption(entity.caption).start,
  };
}

export function entityToVolunteer(entity: CardEntity) {
  return {
    role: entity.title,
    organization: entity.subtitle,
    cause: entity.metadata,
    description: entity.texts.join('\n\n') || null,
    dates: parseDateCaption(entity.caption),
  };
}

export function entityToPublication(entity: CardEntity) {
  return {
    title: entity.title,
    publisher: entity.subtitle,
    description: entity.texts.join('\n\n') || null,
    url: entity.link,
    publishedAt: parseDateCaption(entity.caption).start,
  };
}

/** Card links carry tracking query strings; strip them down to the canonical URL. */
function normaliseCompanyLink(link: string | null): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    if (!url.hostname.endsWith('linkedin.com')) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}/`;
  } catch {
    return null;
  }
}

export type { DateRange };
