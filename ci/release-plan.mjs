// Release rules for .github/workflows/release.yml.
//
// A release tag is vX.Y.Z, it matches `version` in package.json at the tagged
// commit, and `latest` moves to it only when it is the highest vX.Y.Z tag in
// the repository, compared numerically.
//
// Run directly, it reads GITHUB_REF_NAME, package.json, and `git tag -l 'v*'`,
// then writes `version` and `latest` to $GITHUB_OUTPUT, or exits 1 with the
// reason.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

function parseReleaseTag(tag) {
  const match = RELEASE_TAG.exec(tag);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// True when no vX.Y.Z tag in `tags` is higher than `tag`. Other tags, such as
// pre-releases, never count.
export function isHighestRelease(tag, tags) {
  const version = parseReleaseTag(tag);
  if (!version) return false;
  return tags
    .map(parseReleaseTag)
    .filter(Boolean)
    .every((other) => compareVersions(version, other) >= 0);
}

export function planRelease({ tag, packageVersion, tags }) {
  if (!parseReleaseTag(tag ?? '')) {
    throw new Error(
      `${tag} is not a release tag. Release tags look like v1.2.3, with no pre-release suffix. ` +
        'To try a build on the host first, pin its sha- tag.',
    );
  }
  if (tag.slice(1) !== packageVersion) {
    throw new Error(
      `${tag} does not match version ${packageVersion} in package.json. ` +
        `Delete the ${tag} tag, because every vX.Y.Z tag counts when deciding latest. ` +
        'Then tag a main commit whose package.json has the version you want to release.',
    );
  }
  return { version: tag, latest: isHighestRelease(tag, tags) };
}

function main() {
  const tag = process.env.GITHUB_REF_NAME;
  if (!tag) {
    throw new Error('GITHUB_REF_NAME is not set. Set it to the tag being released.');
  }
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const tags = execFileSync('git', ['tag', '-l', 'v*'], { encoding: 'utf8' }).split('\n').filter(Boolean);

  const plan = planRelease({ tag, packageVersion: packageJson.version, tags });

  const outputs = `version=${plan.version}\nlatest=${plan.latest}\n`;
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, outputs);
  }
  process.stdout.write(outputs);
  console.log(
    plan.latest
      ? `${plan.version} is the highest release tag, so latest moves to it.`
      : `${plan.version} is not the highest release tag, so latest stays where it is.`,
  );
}

function runDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (runDirectly()) {
  try {
    main();
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exit(1);
  }
}
