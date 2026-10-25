/**
 * The artist's authored details. `ExternalLinks` on About renders the
 * destinations, and #12 adds the profile. No class names or styling here.
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

export type Artist = {
  /** Array order is display order. */
  destinations: ExternalDestination[];
};

export const artist: Artist = {
  destinations: [
    { id: 'instagram', kind: 'profile', label: 'Instagram', href: 'https://www.instagram.com/iserialclicker', icon: 'instagram', enabled: true },
    { id: '500px', kind: 'profile', label: '500px', href: 'https://500px.com/p/iserialclicker', icon: '500px', enabled: true },
    // The live page links Flickr. It stays on until the owner decides whether it does.
    { id: 'flickr', kind: 'profile', label: 'Flickr', href: 'https://www.flickr.com/photos/iserialclicker', icon: 'flickr', enabled: true },
    { id: 'site-source', kind: 'repository', label: 'Site source', href: 'https://github.com/keyurgolani/keyurgolani.photography', icon: 'github', enabled: true },
  ],
};
