import { zodToJsonSchema } from 'zod-to-json-schema';
import { errorResponseSchema, profileResponseSchema } from './schema/profile.js';

/**
 * OpenAPI document. Built from the same Zod schemas the code uses, so the
 * published contract can't drift from the implementation.
 *
 * Served in "static" mode rather than derived from route schemas — response
 * serialization stays out of Fastify's hands so a schema mismatch can never
 * silently strip fields from a caller's payload.
 */
const toSchema = (schema: Parameters<typeof zodToJsonSchema>[0], name: string) =>
  zodToJsonSchema(schema, { name, $refStrategy: 'none' }).definitions?.[name] ?? {};

export function buildOpenApiDocument(serverUrl: string) {
  const ProfileResponse = toSchema(profileResponseSchema, 'ProfileResponse');
  const ErrorResponse = toSchema(errorResponseSchema, 'ErrorResponse');

  const errorContent = (description: string) => ({
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
  });

  return {
    openapi: '3.0.3',
    info: {
      title: 'LinkedIn Profile API',
      version: '1.0.0',
      description:
        'Accepts a LinkedIn profile URL and returns the profile as structured JSON, sourced from ' +
        "LinkedIn's internal Voyager API. Results are cached in blob storage; live scrapes are hard-capped.",
    },
    servers: [{ url: serverUrl }],
    components: {
      schemas: { ProfileResponse, ErrorResponse },
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
      },
    },
    security: [{ apiKey: [] }],
    paths: {
      '/v1/profile': {
        get: {
          summary: 'Fetch a profile by URL',
          description:
            'Served from cache when a stored copy exists and is within TTL — cache hits do not consume ' +
            'the live-scrape budget. Otherwise performs one live scrape.',
          operationId: 'getProfile',
          parameters: [
            {
              name: 'url',
              in: 'query',
              required: true,
              schema: { type: 'string' },
              description: 'A LinkedIn profile URL, or a bare vanity name.',
              example: 'https://www.linkedin.com/in/williamhgates/',
            },
            {
              name: 'refresh',
              in: 'query',
              required: false,
              schema: { type: 'boolean', default: false },
              description: 'Bypass the cache and force a live scrape. Consumes scrape budget.',
            },
          ],
          responses: {
            200: {
              description: 'The profile.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ProfileResponse' } } },
            },
            400: errorContent('The URL was not a parseable LinkedIn member profile URL.'),
            401: errorContent('Missing or invalid API key.'),
            403: errorContent('The profile exists but is not visible to the configured session.'),
            404: errorContent('No profile exists at that identifier.'),
            429: errorContent('Live-scrape budget exhausted, or per-caller rate limit hit. See retryAfterSeconds.'),
            503: errorContent('LinkedIn blocked the request, or no healthy identity is available.'),
          },
        },
        post: {
          summary: 'Fetch a profile by URL (JSON body)',
          operationId: 'postProfile',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['url'],
                  properties: {
                    url: { type: 'string', example: 'https://www.linkedin.com/in/williamhgates/' },
                    refresh: { type: 'boolean', default: false },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'The profile.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ProfileResponse' } } },
            },
            400: errorContent('Invalid request body or URL.'),
            429: errorContent('Rate limited.'),
          },
        },
      },
      '/v1/profile/{publicId}/cache': {
        delete: {
          summary: 'Evict a cached profile',
          operationId: 'invalidateProfile',
          parameters: [{ name: 'publicId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: {
              description: 'Whether an entry was removed.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { success: { type: 'boolean' }, evicted: { type: 'boolean' } },
                  },
                },
              },
            },
          },
        },
      },
      '/health': {
        get: {
          summary: 'Liveness and dependency health',
          operationId: 'health',
          security: [],
          responses: { 200: { description: 'Service health, identity pool state, and scrape budget.' } },
        },
      },
    },
  };
}
