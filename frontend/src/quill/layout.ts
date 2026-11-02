/**
 * Which layout Artifacts opens in on this device: `new` (on Quill, PDR-010)
 * or `classic` (the Lit layout from before it). The new one is the default;
 * the classic one stays until everything in it is in the new one, and the
 * person can switch either way from either.
 */
export type Layout = 'new' | 'classic';

export const LAYOUT_KEY = 'augur-artifacts:layout';

export const readLayout = (): Layout => {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'classic' ? 'classic' : 'new';
  } catch {
    return 'new';
  }
};

export const keepLayout = (layout: Layout) => {
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    // Private windows may not keep it: the switch still works for this visit.
  }
};
