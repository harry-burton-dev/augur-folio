import type { AppManifest } from '@augur/service-kit';
import { homeSchema } from './api-types.ts';

/**
 * The service's OpenAPI document, served at the manifest's `api.openapi` path; the registry reads it
 * after install. Built from the wire types' schemas, so it says what the routes answer.
 */
export const openApi = (manifest: AppManifest, version: string, api: string) => ({
  openapi: '3.1.0',
  info: { title: manifest.name, version },
  servers: [{ url: `/api/${manifest.id}` }],
  paths: {
    [`/${api}/home`]: {
      get: {
        operationId: 'getHome',
        summary: 'What needs the person on this floor, then what’s new since they looked',
        responses: {
          200: { description: 'Home', content: { 'application/json': { schema: homeSchema } } },
          400: { description: 'No floor named', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
          401: { description: 'Nobody signed in', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
        },
      },
    },
  },
  components: {
    schemas: {
      // RFC 9457, as every AUGUR service answers an error (the service kit's problemDetails).
      Problem: {
        type: 'object',
        required: ['type', 'title', 'status'],
        properties: { type: { type: 'string' }, title: { type: 'string' }, status: { type: 'integer' }, detail: { type: 'string' }, reason: { type: 'string' }, whoCanChange: { type: 'string' } },
      },
    },
  },
});
