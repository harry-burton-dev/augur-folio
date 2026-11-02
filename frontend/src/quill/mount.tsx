import { createRoot, type Root } from 'react-dom/client';
import { Artifacts, type ArtifactsProps } from './artifacts.js';
import styles from './styles.css?inline';

const roots = new WeakMap<HTMLElement, Root>();
const STYLE_ID = 'augur-artifacts-styles';

/** Mounts the new layout in `el`, adding its stylesheet to the page once. */
export const mountArtifacts = (el: HTMLElement, props: ArtifactsProps) => {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = styles;
    document.head.append(style);
  }
  const root = createRoot(el);
  roots.set(el, root);
  root.render(<Artifacts {...props} />);
};

/** Takes the new layout out of `el`, if it's there. */
export const unmountArtifacts = (el: HTMLElement) => {
  roots.get(el)?.unmount();
  roots.delete(el);
};
