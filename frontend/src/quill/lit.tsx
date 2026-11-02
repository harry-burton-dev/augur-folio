import { createElement, useLayoutEffect, useRef } from 'react';

export interface LitProps {
  /** The custom element's tag: one of Folio's own Lit parts (`folio-reader`, `folio-share`, ...). */
  tag: string;
  /** Set as properties, so objects and functions go through as they are. */
  props?: Record<string, unknown>;
  /** Its events, by name (`folio-back`). */
  on?: Record<string, (e: CustomEvent) => void>;
  className?: string;
}

/**
 * One of Folio's Lit parts inside the new layout, until each has a Quill
 * equivalent: the reader, sharing, publishing and publishing up. Properties
 * and listeners are set on the element itself, so nothing depends on how a
 * React version maps props onto custom elements.
 */
export function Lit({ tag, props = {}, on = {}, className }: LitProps) {
  const el = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const node = el.current as (HTMLElement & Record<string, unknown>) | null;
    if (!node) return;
    for (const [key, value] of Object.entries(props)) node[key] = value;
  });
  // The latest handlers, without re-adding listeners on every render.
  const handlers = useRef(on);
  handlers.current = on;
  const names = Object.keys(on).sort().join(' ');
  useLayoutEffect(() => {
    const node = el.current;
    if (!node || !names) return;
    const bound = names.split(' ').map((name) => [name, (e: Event) => handlers.current[name]?.(e as CustomEvent)] as const);
    for (const [name, fn] of bound) node.addEventListener(name, fn);
    return () => bound.forEach(([name, fn]) => node.removeEventListener(name, fn));
  }, [names]);
  return createElement(tag, { ref: el, class: className });
}
