import type { ExternalDestinationIcon } from '@/data/artist';

/**
 * Path data for each mark, from Simple Icons (CC0-1.0) on its 24 by 24 grid.
 * Empty until the owner approves fetching them.
 */
const PATHS: Record<ExternalDestinationIcon, string> = {
  instagram: '',
  '500px': '',
  flickr: '',
  github: '',
};

/** A monochrome brand mark in `currentColor`, hidden from assistive technology. */
export default function ExternalLinkIcon({ icon, className }: { icon: ExternalDestinationIcon; className?: string }) {
  const path = PATHS[icon];
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      data-icon={icon}
      className={className}
    >
      {path ? <path d={path} /> : null}
    </svg>
  );
}
