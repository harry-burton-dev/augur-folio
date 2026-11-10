import type { AppManifest } from '@augur/service-kit';
import { homeSchema } from './api-types.ts';

/** The library's routes, each with what it does; their shapes are the wire types in api-types.ts. */
const ROUTES: Record<string, Record<string, string>> = {
  '/home/looked': { post: 'The person has seen what’s new on this floor' },
  '/library': { get: 'The floor’s library: its collections, the levels and what the caller may do (LibraryAnswer)', patch: 'Whether anyone who tags may make tags' },
  '/folders': { post: 'Make a collection, or a folder in one (FolderView)' },
  '/folders/{id}': { get: 'A folder, the path to it and what’s in it (FolderAnswer)', patch: 'Rename it or say what it’s for', delete: 'Delete an empty folder' },
  '/folders/{id}/state': { post: 'Open, close or archive it' },
  '/folders/{id}/tags': { put: 'Set its tags, which count for everything inside it' },
  '/folders/{id}/documents': { get: 'A page of its documents, filtered (DocumentPage)', post: 'Add a document: the file is the body, its name in ?filename=' },
  '/documents/{id}': { get: 'A document, its versions and their moves (DocumentAnswer)', patch: 'Retitle it or move it to another folder on its floor', delete: 'Delete it, kept for the retention setting’s days' },
  '/documents/{id}/tags': { put: 'Set its tags' },
  '/documents/{id}/versions': { post: 'Add the next version: the file is the body, its name in ?filename=' },
  '/documents/{id}/versions/{number}/file': { get: 'The version’s file, as it was sent' },
  '/documents/{id}/versions/{number}/reader': { get: 'Its copy to read, as Markdown for the kit’s reader, or why there is none (ReaderAnswer)', post: 'Ask again for a copy that couldn’t be made' },
  '/documents/{id}/versions/{number}/pictures/{name}': { get: 'A picture its copy to read names' },
  '/documents/{id}/versions/{number}/thumbnail': { get: 'A picture of its first page, when it has one' },
  '/documents/{id}/versions/{number}/state': { post: 'Move a version on in its life; In review puts it in the floor’s leads’ Inbox' },
  '/tags': { get: 'The org’s tags and the floor’s own (TagView)', post: 'Make a tag' },
  '/levels/{level}': { put: 'What the org calls a level' },
  '/grants': { get: 'Who a thing is shared with (GrantView)', put: 'Share it with a person, a team or everyone', delete: 'Stop sharing it with them' },
  '/shared': { get: 'What other floors have shared with the caller (SharedItem)' },
  '/people': { get: 'People and teams to share with (PeopleAnswer)' },
  '/search': { get: 'Find: the floor’s documents whose title matches, best first, at most ten' },
};

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
    ...Object.fromEntries(
      Object.entries(ROUTES).map(([path, methods]) => [
        `/${api}${path}`,
        Object.fromEntries(
          Object.entries(methods).map(([method, summary]) => [
            method,
            {
              summary,
              responses: {
                default: { description: 'What the route answers; an error is a problem', content: { 'application/json': { schema: { type: 'object' } }, 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
              },
            },
          ]),
        ),
      ]),
    ),
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
