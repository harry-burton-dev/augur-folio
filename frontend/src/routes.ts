/**
 * Where in Artifacts a path below `/<id>` leads. The host owns the address (spec 6.12): the app reads
 * `ctx.path` and hears each move with `ctx.onNavigate`, and asks to move with `ctx.navigate`.
 * The rail's places are the manifest's: Home `/`, Library `/library`, Shared with you `/shared`,
 * From below `/below`.
 */
export type Route =
  | { kind: 'home' }
  | { kind: 'library' }
  | { kind: 'folder'; id: string }
  | { kind: 'document'; id: string; version?: number }
  | { kind: 'shared' }
  | { kind: 'below' }
  | { kind: 'missing'; path: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export const routeOf = (path: string): Route => {
  const parts = path.split(/[?#]/)[0]!.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  const [first, id, sub, number] = parts;
  if (!first) return { kind: 'home' };
  if (parts.length === 1 && first === 'library') return { kind: 'library' };
  if (parts.length === 1 && first === 'shared') return { kind: 'shared' };
  if (parts.length === 1 && first === 'below') return { kind: 'below' };
  if (first === 'folders' && parts.length === 2 && ID.test(id!)) return { kind: 'folder', id: id! };
  if (first === 'documents' && id && ID.test(id)) {
    if (parts.length === 2) return { kind: 'document', id };
    const n = Number(number);
    if (parts.length === 4 && sub === 'versions' && Number.isInteger(n) && n > 0) return { kind: 'document', id, version: n };
  }
  return { kind: 'missing', path };
};

export const pathOf = (route: Route): string => {
  switch (route.kind) {
    case 'home':
      return '/';
    case 'library':
    case 'shared':
    case 'below':
      return `/${route.kind}`;
    case 'folder':
      return `/folders/${route.id}`;
    case 'document':
      return route.version ? `/documents/${route.id}/versions/${route.version}` : `/documents/${route.id}`;
    case 'missing':
      return route.path;
  }
};
