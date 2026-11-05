import { defineReactApp } from '@augur/app-kit';
import type { MountContext } from '@augur/mfe-sdk';
import { APP_NAME } from './api.js';
import { App, Glance, Picker, places } from './app.js';
import { OPENING, startFor } from './intents.js';
import styles from './quill/styles.css?inline';

export { ACCESS_EXPLAIN, FOLIO_OPEN, openFrom, pickFrom, placeForIntent, proposeFrom, startFor } from './intents.js';

/**
 * Artifacts: libraries of documents on each floor. What the shell mounts at its
 * route: the app and its places, the picker another app opens it as
 * (`document.pick`), and its card on Home.
 */
export default defineReactApp<MountContext>({
  name: APP_NAME,
  App,
  routes: places,
  intents: Object.fromEntries(OPENING.map((type) => [type, (payload: unknown) => startFor({ type, payload })])),
  Picker,
  Glance,
  styles,
});
