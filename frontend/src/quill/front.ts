import type { FrontPageConfig } from '@augur/app-kit';

/**
 * Artifacts' front page, as config (PDR-010, App patterns, in the AUGUR handbook): the same
 * FrontPage any app builds from its own. Section ids are what the app fills:
 * `actions` (what needs the person), `new` (put out to them since they last
 * looked) and `upcoming` (the next issue each series expects).
 *
 * PDR-010's amendments are the defaults: the plain look (amendment 5), quiet
 * ambience, which dims what's out of focus without blurring anything people
 * read (amendment 1), and Actions showing everything that needs you at once
 * (amendment 3). New keeps the pull. Harry's first choices are one change away
 * here: `look: 'title'`, `ambience: 'soft'` and `reveal: 'pull'` on Actions.
 */
export const ARTIFACTS_FRONT: FrontPageConfig = {
  look: 'plain',
  ambience: 'quiet',
  sections: [
    { id: 'actions', title: 'Actions', empty: 'Nothing needs you here.', layout: 'reel', tone: 'action', reveal: 'all', noun: 'action' },
    { id: 'new', title: 'New', empty: 'Nothing new since you last looked.', layout: 'reel', tone: 'new', reveal: 'pull', noun: 'new document' },
    { id: 'upcoming', title: 'Upcoming', empty: 'No series expects an issue soon.', layout: 'reel', tone: 'upcoming', reveal: 'all', noun: 'upcoming issue' },
  ],
};
