/**
 * Which layout Artifacts opens in on this device: `new` (on Quill, PDR-010)
 * or `classic` (the Lit layout from before it). The new one is the default;
 * the classic one stays until everything in it is in the new one, and the
 * person can switch either way from either. Only the person's own choice is
 * kept: a part the new layout hasn't got yet opens the classic one for that
 * visit, and the next visit opens the new one again.
 */
export type Layout = 'new' | 'classic';

/**
 * Version 2: before it, opening any part not yet rebuilt kept the classic
 * layout for good, so devices that once did that are back on the new one.
 */
export const LAYOUT_KEY = 'augur-artifacts:layout-2';

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
