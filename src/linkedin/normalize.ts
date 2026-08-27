/**
 * LinkedIn's `application/vnd.linkedin.normalized+json+2.1` encoding.
 *
 * Rather than nesting objects, Voyager returns a *flattened graph*:
 *
 *   {
 *     "data":     { "*elements": ["urn:li:fsd_profile:ABC"] },
 *     "included": [ { "entityUrn": "urn:li:fsd_profile:ABC", "$type": "...", "*profilePicture": "urn:li:..." } ]
 *   }
 *
 * Any key beginning with `*` holds a URN (or array of URNs) pointing into
 * `included[]` instead of the value itself. This exists so LinkedIn can send a
 * company object once even when forty positions reference it.
 *
 * Everything downstream is far easier to write against a real object tree, so
 * we rehydrate the graph once, here, and parse normal nested objects after.
 * Cycles are real (company → employee → company), hence the seen-set.
 */

export type Json = unknown;

interface JsonObject {
  [key: string]: Json;
}

const isObject = (v: Json): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface NormalizedPayload {
  data: Json;
  included: JsonObject[];
}

export function asNormalizedPayload(body: Json): NormalizedPayload {
  if (!isObject(body)) return { data: null, included: [] };
  const included = Array.isArray(body.included) ? (body.included.filter(isObject) as JsonObject[]) : [];
  return { data: body.data ?? body, included };
}

/** Index of entityUrn → entity, the lookup table the whole resolver runs on. */
export function buildIndex(included: JsonObject[]): Map<string, JsonObject> {
  const index = new Map<string, JsonObject>();
  for (const entity of included) {
    const urn = entity.entityUrn;
    if (typeof urn === 'string') index.set(urn, entity);
    // Some entities additionally carry a `*entityUrn`-less dash id.
    const dashUrn = entity.dashEntityUrn;
    if (typeof dashUrn === 'string' && !index.has(dashUrn)) index.set(dashUrn, entity);
  }
  return index;
}

/**
 * Depth-limited to keep a pathological payload from blowing the stack — the
 * real profile graph is nowhere near this deep.
 */
const MAX_DEPTH = 24;

export function resolveGraph(node: Json, index: Map<string, JsonObject>, seen = new Set<string>(), depth = 0): Json {
  if (depth > MAX_DEPTH) return node;

  if (Array.isArray(node)) {
    return node.map((item) => resolveGraph(item, index, seen, depth + 1));
  }

  if (!isObject(node)) return node;

  const out: JsonObject = {};

  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith('*')) {
      out[key] = resolveGraph(value, index, seen, depth + 1);
      continue;
    }

    // `*foo` is a reference — expose the resolved value under `foo`, and keep
    // the raw urn under `fooUrn` because some of it is genuinely useful.
    const plainKey = key.slice(1);

    if (typeof value === 'string') {
      out[`${plainKey}Urn`] = value;
      out[plainKey] = expand(value, index, seen, depth);
    } else if (Array.isArray(value)) {
      out[`${plainKey}Urns`] = value;
      out[plainKey] = value.map((urn) =>
        typeof urn === 'string' ? expand(urn, index, seen, depth) : resolveGraph(urn, index, seen, depth + 1),
      );
    } else {
      out[plainKey] = resolveGraph(value, index, seen, depth + 1);
    }
  }

  return out;
}

function expand(urn: string, index: Map<string, JsonObject>, seen: Set<string>, depth: number): Json {
  const target = index.get(urn);
  if (!target) return null;
  if (seen.has(urn)) return { entityUrn: urn, $circular: true };

  seen.add(urn);
  const resolved = resolveGraph(target, index, seen, depth + 1);
  seen.delete(urn);
  return resolved;
}

/** One-shot: take a raw Voyager body and return the fully rehydrated tree. */
export function normalize(body: Json): { data: Json; index: Map<string, JsonObject>; included: JsonObject[] } {
  const { data, included } = asNormalizedPayload(body);
  const index = buildIndex(included);
  return { data: resolveGraph(data, index), index, included };
}

/**
 * Pulls every `included` entity whose `$type` matches — the reliable way to
 * find e.g. all Position records when the card layout has changed shape.
 */
export function collectByType(included: JsonObject[], typeSuffix: string, index: Map<string, JsonObject>): JsonObject[] {
  return included
    .filter((e) => typeof e.$type === 'string' && (e.$type as string).endsWith(typeSuffix))
    .map((e) => resolveGraph(e, index) as JsonObject);
}
