/**
 * The artist's authored details: About's profile and its external
 * destinations. Only people edit this file. Photo ingestion, EXIF, and the
 * catalog never write it, and it compiles at `next build`. Copy is plain text
 * that renders as React text, with no markup, class names, or layout hints.
 */

export type ExternalDestinationKind = 'profile' | 'repository' | 'contact';

/** The marks `ExternalLinkIcon` draws. */
export const EXTERNAL_DESTINATION_ICONS = ['instagram', '500px', 'flickr', 'github'] as const;
export type ExternalDestinationIcon = (typeof EXTERNAL_DESTINATION_ICONS)[number];

export type ExternalDestination = {
  /** Unique, stable, and kebab-case. */
  id: string;
  kind: ExternalDestinationKind;
  /** The visible text. The link's accessible name starts with it. */
  label: string;
  /** `https:` for a profile or the repository, `mailto:` for a contact. */
  href: string;
  /** Required for profile and repository entries. A contact renders text only. */
  icon?: ExternalDestinationIcon;
  enabled: boolean;
};

/**
 * `'provisional'` until the owner approves every piece of copy below, and
 * `npm run build` fails while it is (`assertPublishableCopy`).
 */
export type CopyStatus = 'provisional' | 'approved';

/**
 * The portrait's authored facts. The file itself is a static import in
 * `data/artistPortraitImage.ts`, since Playwright, which imports this module,
 * can't load a `.png`. Swapping the portrait changes that import and these
 * fields together.
 */
export type ArtistPortrait = {
  /** The file's intrinsic size in px. */
  width: number;
  height: number;
  alt: string;
  /** Percent from the top left, 0 to 100. The crop's `object-position`, 50/50 when unset. */
  focalPoint?: { x: number; y: number };
};

export type ArtistProfile = {
  copyStatus: CopyStatus;
  name: string;
  alias?: string;
  /** Unset, About shows the name and alias in its place. */
  portrait?: ArtistPortrait;
  /** About's `h1`. */
  statementHeading: string;
  statementParagraphs: string[];
  shortBiography?: string;
};

export type Artist = {
  profile: ArtistProfile;
  /** Array order is display order. */
  destinations: ExternalDestination[];
};

export const artist: Artist = {
  // A placeholder from the approved mockup, which labels its own text
  // provisional. None of it is the owner's yet: he writes the heading, the
  // paragraphs, and any biography, confirms the alias and the alt text, and
  // then sets copyStatus to 'approved'. The mockup's paragraph about edited and
  // sequenced bodies of work is left out, since Home shuffles and Gallery is
  // one newest-first feed until the catalog cutover.
  profile: {
    copyStatus: 'provisional',
    name: 'Keyur Golani',
    alias: 'ISerialClicker',
    portrait: {
      width: 3394,
      height: 3620,
      alt: 'Keyur Golani, seated, in aviator sunglasses and a dark cable-knit turtleneck',
      focalPoint: { x: 52, y: 26 },
    },
    statementHeading: 'I photograph the distance between a place and the way it is remembered.',
    statementParagraphs: [
      'The work returns to landscape, weather, travel, and brief encounters. I am drawn to the moment a descriptive frame also becomes an arrangement of color, scale, and rhythm.',
    ],
  },
  destinations: [
    { id: 'instagram', kind: 'profile', label: 'Instagram', href: 'https://www.instagram.com/iserialclicker', icon: 'instagram', enabled: true },
    { id: '500px', kind: 'profile', label: '500px', href: 'https://500px.com/p/iserialclicker', icon: '500px', enabled: true },
    // The live page links Flickr. It stays on until the owner decides whether it does.
    { id: 'flickr', kind: 'profile', label: 'Flickr', href: 'https://www.flickr.com/photos/iserialclicker', icon: 'flickr', enabled: true },
    { id: 'site-source', kind: 'repository', label: 'Site source', href: 'https://github.com/keyurgolani/keyurgolani.photography', icon: 'github', enabled: true },
  ],
};
