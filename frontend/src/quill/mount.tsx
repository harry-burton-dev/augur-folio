import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Artifacts, type ArtifactsProps } from './artifacts.js';
import { Glance, type GlanceProps } from './glance.js';
import { Picker, type PickerProps } from './picker.js';
import styles from './styles.css?inline';

const roots = new WeakMap<HTMLElement, Root>();
const STYLE_ID = 'augur-artifacts-styles';

/** Renders `node` in `el` with React, adding Artifacts' stylesheet to the page once. */
const show = (el: HTMLElement, node: ReactNode) => {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = styles;
    document.head.append(style);
  }
  const root = createRoot(el);
  roots.set(el, root);
  root.render(node);
};

/** Mounts the new layout in `el`. */
export const mountArtifacts = (el: HTMLElement, props: ArtifactsProps) => show(el, <Artifacts {...props} />);

/** Mounts the picker another app opens Artifacts as (`document.pick`). */
export const mountPicker = (el: HTMLElement, props: PickerProps) => show(el, <Picker {...props} />);

/** Mounts Artifacts' card on Home. */
export const mountGlance = (el: HTMLElement, props: GlanceProps) => show(el, <Glance {...props} />);

/** Takes whatever Artifacts mounted with React out of `el`, if anything. */
export const unmountArtifacts = (el: HTMLElement) => {
  roots.get(el)?.unmount();
  roots.delete(el);
};
