import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { parseProfileUrl } from '../linkedin/url.js';
import type { ProfileService } from '../service/profile-service.js';

const querySchema = z.object({
  url: z.string().optional(),
  // Accept ?refresh, ?refresh=true, ?refresh=1
  refresh: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => v === true || v === '' || v === 'true' || v === '1'),
});

const bodySchema = z.object({
  url: z.string(),
  refresh: z.boolean().optional().default(false),
});

export function registerProfileRoutes(app: FastifyInstance, service: ProfileService): void {
  app.get('/v1/profile', async (request, reply) => {
    const query = querySchema.safeParse(request.query);
    if (!query.success || !query.data.url) {
      throw new ApiError('INVALID_URL', 'Query parameter "url" is required, e.g. /v1/profile?url=https://www.linkedin.com/in/name');
    }

    const { publicId, canonicalUrl } = parseProfileUrl(query.data.url);
    const result = await service.getProfile({ publicId, profileUrl: canonicalUrl, refresh: query.data.refresh });

    reply.header('x-cache', result.meta.cached ? 'HIT' : 'MISS');
    reply.header('x-source', result.meta.source);
    return { success: true as const, ...result };
  });

  app.post('/v1/profile', async (request, reply) => {
    const body = bodySchema.safeParse(request.body);
    if (!body.success) {
      throw new ApiError('INVALID_URL', 'Request body must be JSON of the form { "url": "https://www.linkedin.com/in/name" }.', {
        details: { issues: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      });
    }

    const { publicId, canonicalUrl } = parseProfileUrl(body.data.url);
    const result = await service.getProfile({ publicId, profileUrl: canonicalUrl, refresh: body.data.refresh });

    reply.header('x-cache', result.meta.cached ? 'HIT' : 'MISS');
    reply.header('x-source', result.meta.source);
    return { success: true as const, ...result };
  });

  app.delete<{ Params: { publicId: string } }>('/v1/profile/:publicId/cache', async (request) => {
    const { publicId } = parseProfileUrl(request.params.publicId);
    const evicted = await service.invalidate(publicId);
    return { success: true as const, publicId, evicted };
  });
}
