// Artifacts' wire types, written once. The service answers with them, its OpenAPI document (openapi.ts)
// describes them and the frontend reads them (frontend/src imports this file), so none of the three
// can drift from the others (AUGUR's ADR 0055).

/** One thing on Home: a document or a piece of work, and where in the app it opens. */
export interface HomeItem {
  id: string;
  title: string;
  /** One line under it: why it is here ("Waiting for your review since Monday"). */
  detail?: string;
  /** Where it opens, below the app's address. */
  path: string;
}

/** `GET /v1/home`: what needs the person on this floor first, then what's new since they looked. */
export interface Home {
  floor: { id: string; kind: 'personal' | 'team' | 'org' };
  needsYou: HomeItem[];
  latest: HomeItem[];
}

const homeItemSchema = {
  type: 'object',
  required: ['id', 'title', 'path'],
  additionalProperties: false,
  properties: { id: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' }, path: { type: 'string' } },
} as const;

/** `Home` as JSON Schema: the route's response schema and the OpenAPI document's. */
export const homeSchema = {
  type: 'object',
  required: ['floor', 'needsYou', 'latest'],
  additionalProperties: false,
  properties: {
    floor: {
      type: 'object',
      required: ['id', 'kind'],
      additionalProperties: false,
      properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['personal', 'team', 'org'] } },
    },
    needsYou: { type: 'array', items: homeItemSchema },
    latest: { type: 'array', items: homeItemSchema },
  },
} as const;
