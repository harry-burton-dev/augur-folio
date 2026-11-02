import type { FrontPageConfig } from '@augur/app-kit';

/**
 * Artifacts' front page, as config (PDR-010, docs/app-patterns.md): the same
 * FrontPage any app builds from its own. Section ids are what the app fills:
 * `actions` (what needs the person), `new` (put out to them since they last
 * looked) and `upcoming` (the next issue each series expects).
 *
 * Harry's choices are the defaults: the title look, and reels that pull their
 * cards in behind a light. The alternatives PDR-010 proposes are one change
 * away here: `look: 'plain'`, `ambience: 'quiet'`, and `reveal: 'all'` on
 * Actions so everything that needs you shows at once.
 */
export const ARTIFACTS_FRONT: FrontPageConfig = {
  look: 'title',
  ambience: 'soft',
  sections: [
    { id: 'actions', title: 'Actions', empty: 'Nothing needs you here.', layout: 'reel', tone: 'action', reveal: 'pull', noun: 'action' },
    { id: 'new', title: 'New', empty: 'Nothing new since you last looked.', layout: 'reel', tone: 'new', reveal: 'pull', noun: 'new document' },
    { id: 'upcoming', title: 'Upcoming', empty: 'No series expects an issue soon.', layout: 'reel', tone: 'upcoming', reveal: 'all', noun: 'upcoming issue' },
  ],
};
