// #184: what the accessibility contract's owner pass must hold. test/hostDocs.test.mjs runs it on the contract, and on
// copies with each acceptance step taken out, so a step that goes missing fails it.

export const HEADING = "## The owner's screen-reader and device pass";

export const AREAS = ['Home', 'Site navigation and the theme menu', 'The Viewer', 'Publish', 'The Inbox', 'What to do with a finding'];

/**
 * #184's acceptance steps, the two the plan adds, the Viewer heading in NVDA's browse mode, and an early press on every
 * curator form behind the submit gate: the Inbox's, Publish's, History's and the Series screens'. Each is one step in its area: a step whose bold title matches every `title` pattern, and whose whole text
 * matches every `body` pattern.
 */
export const ACCEPTANCE = [
  { name: 'Home, one double-tap with VoiceOver', area: 'Home', title: [/double-tap/i, /VoiceOver on iOS Safari/], body: [/Next photograph/, /Work/] },
  { name: 'Home, one double-tap with TalkBack', area: 'Home', title: [/double-tap/i, /TalkBack on Android Chrome/], body: [/Next photograph/] },
  { name: 'Home, Enter in macOS Safari with a mouse', area: 'Home', title: [/Enter/, /macOS Safari, with a mouse/], body: [/does nothing|activates nothing/i, /controls come back/] },
  { name: 'Home, All bodies of work and All work', area: 'Home', title: [/link/i], body: [/All bodies of work/, /All work/] },
  { name: 'the navigation and the current page', area: 'Site navigation and the theme menu', title: [/navigation/i, /current page/i, /iOS and macOS Safari/], body: [/Primary/, /current page/] },
  { name: 'the theme menu', area: 'Site navigation and the theme menu', title: [/theme menu/i, /iOS and macOS Safari/], body: [/five/, /radio/, /Escape/, /focus/] },
  { name: "Work's statement and count read twice", area: 'Site navigation and the theme menu', title: [/Work/], body: [/statement and the count/, /again/] },
  { name: 'the Viewer on a phone, screen reader off', area: 'The Viewer', title: [/screen reader off/i, /iPhone Safari/, /Android Chrome/], body: [/open/i, /swipe/i, /Zoom/, /Close/] },
  { name: 'the Viewer on a phone, screen reader on', area: 'The Viewer', title: [/screen reader on/i, /iPhone Safari/, /Android Chrome/], body: [/opens/, /move/, /photograph in/, /Zoom/, /Close/, /focus/] },
  { name: 'the end message twice', area: 'The Viewer', title: [/end/i, /twice/i], body: [/both times/] },
  { name: 'the Viewer modal', area: 'The Viewer', title: [/modal/i, /VoiceOver with Safari/, /NVDA with Chrome/], body: [/dialog/, /Escape/, /focus/] },
  { name: 'the Viewer page', area: 'The Viewer', title: [/page/i, /VoiceOver with Safari/, /NVDA with Chrome/], body: [/main landmark/, /no dialog/i] },
  { name: "the Viewer heading in NVDA's browse mode", area: 'The Viewer', title: [/heading/i, /browse mode/i, /NVDA with Chrome/], body: [/aria-label/, /photograph 3 of 12/, /once/, /doubled title/] },
  // #184's recheck adds lie-fi: online by navigator.onLine, but nothing loads (#217).
  { name: 'the Viewer on lie-fi', area: 'The Viewer', title: [/Lie-fi/, /iPhone Safari/, /NVDA with Chrome/], body: [/still says it's online/, /long latency/, /no offline notice/, /#217/, /fetched ahead, so the move lands and is announced/, /nothing is said while the move waits/, /navigator\.onLine/, /FULL_PREFETCH/] },
  { name: 'the grouped ledger', area: 'Publish', title: [/group/i, /ledger/i], body: [/heading level 3/] },
  { name: 'a collapsed group', area: 'Publish', title: [/collapsed/i], body: [/collapsed/, /expanded/] },
  { name: 'a review', area: 'Publish', title: [/review/i], body: [/mark reviewed/i] },
  { name: 'the stale live region', area: 'Publish', title: [/stale/i, /live region/i], body: [/went stale/] },
  { name: 'Base moved', area: 'Publish', title: [/Base moved/], body: [/Load the updated ledger/] },
  { name: 'the Inbox list and filters', area: 'The Inbox', title: [/list/i, /filters/i], body: [/Filter the inbox/, /heading level/] },
  { name: "one item's detail", area: 'The Inbox', title: [/detail/i], body: [/focus/, /heading/] },
  { name: "an action's error summary", area: 'The Inbox', title: [/error summary/i], body: [/focus/, /summary/] },
  { name: 'the stale role="alert"', area: 'The Inbox', title: [/stale/i, /role="alert"/], body: [/alert/, /typed|edits/] },
  {
    name: 'an early press on a curator form',
    area: 'The Inbox',
    title: [/early press/i],
    body: [
      /Still loading\. Try again in a moment\./,
      /once/,
      /politely/,
      /second press/,
      /Validate revision/,
      /Restore revision/,
      /Series/,
      /submitGateScript\.ts/,
      /curation-inbox-gate\.spec\.ts/,
      /curation-publish-gate\.spec\.ts/,
      /curation-history-gate\.spec\.ts/,
      /curation-series-gate\.spec\.ts/,
    ],
  },
  // #17's three Inbox pieces, ruled for the release candidate: the owner confirms each one's copy and behaviour, and may change any for the final.
  { name: 'Restore on an archived photograph', area: 'The Inbox', title: [/Restore/, /owner to confirm the copy and behaviour/], body: [/This file matches <file>, an archived photograph\. Restore brings it back with its original details, outside any series\. Add it to a series from the Series screen afterwards\./, /Approve/, /Dismiss/, /Restore recorded, and waiting for the watcher\. On its next pass, <file> comes back with its original details, outside any series\./] },
  { name: "Bind's suggested files", area: 'The Inbox', title: [/suggested files/i, /owner to confirm the copy and behaviour/], body: [/<path>: same file name, different pixels/, /<path>: taken at the same moment, different pixels/, /Another file in the library/, /No suggestion is checked/] },
  { name: 'held items, Release and the library banner', area: 'The Inbox', title: [/Held/, /Release/, /banner/i, /owner to confirm the copy and behaviour/], body: [/The library can't be reached \(<cause>\), so nothing changes until it's back\. <N> missing items are on hold\./, /This item is on hold because the library can't be reached\. Release it only if its file is really gone: it then counts as missing, and Bind or Archive settles it\./, /items require judgment, 20 held/, /Dismiss/, /With nothing held, it reads "The library can't be reached \(<cause>\), so nothing changes until it's back\.", with no second sentence\./, /Release each held item, or run curation confirm-missing, to release one that's really gone\./] },
  // The Inbox without JavaScript, ruled for the release candidate in the same way: the owner confirms its note's copy and behaviour.
  { name: 'the Inbox without JavaScript', area: 'The Inbox', title: [/without JavaScript/, /owner to confirm the copy and behaviour/], body: [/Loading the inbox/, /The Inbox and its header, with Sign out, need JavaScript\. Nothing is written without it\./, /outside/, /app\/curation\/inbox\/loading\.tsx/, /curation-inbox-gate-nojs\.spec\.ts/] },
];

/** The section, its parts by heading, and each part's checkbox steps with their bold titles. */
export function ownerPass(contract) {
  const start = contract.indexOf(`\n${HEADING}\n`);
  if (start === -1) return null;
  const rest = contract.slice(start + 1);
  const next = rest.indexOf('\n## ', 3);
  const section = next === -1 ? rest : rest.slice(0, next);
  const parts = Object.fromEntries(
    section
      .split(/\n(?=### )/)
      .slice(1)
      .map((part) => [part.slice(4, part.indexOf('\n')).trim(), part]),
  );
  const steps = Object.fromEntries(
    Object.entries(parts).map(([area, text]) => [
      area,
      text
        .split(/\n(?=\S)/)
        .filter((block) => /^- \[ \] /.test(block))
        .map((block) => ({ title: /^- \[ \] \*\*(.+?)\*\*/.exec(block)?.[1] ?? '', text: block })),
    ]),
  );
  return { section, parts, steps };
}

/** What's wrong with the contract's owner pass, as plain lines. None when it holds. */
export function ownerPassProblems(contract) {
  const pass = ownerPass(contract);
  if (pass === null) return ['no owner pass section'];
  const problems = [];
  if (contract.split(`\n${HEADING}\n`).length !== 2) problems.push('the section appears more than once');
  const areas = Object.keys(pass.parts);
  if (areas.join('|') !== AREAS.join('|')) problems.push(`the parts are ${areas.join(', ')}`);
  for (const area of AREAS.slice(0, -1)) {
    for (const step of pass.steps[area] ?? []) {
      if (step.title === '') problems.push(`${area}: a step with no bold title`);
      if (!/\bExpect\b/.test(step.text)) problems.push(`${area}: "${step.title}" says nothing to expect`);
    }
  }
  // Each step once, across the whole section: a rebase or a merge that pastes a step twice fails here.
  const titles = new Map();
  for (const step of Object.values(pass.steps).flat()) if (step.title !== '') titles.set(step.title, (titles.get(step.title) ?? 0) + 1);
  for (const [title, count] of titles) if (count > 1) problems.push(`step appears ${count === 2 ? 'twice' : `${count} times`}: ${title}`);
  // Each acceptance item names exactly one step, so a doubled step, or words loose enough to match two, fail too.
  for (const item of ACCEPTANCE) {
    const matches = (pass.steps[item.area] ?? []).filter((step) => item.title.every((words) => words.test(step.title)) && item.body.every((words) => words.test(step.text))).length;
    if (matches === 0) problems.push(`no step for ${item.name}`);
    else if (matches > 1) problems.push(`${item.name} matches ${matches} steps`);
  }
  const finding = pass.parts['What to do with a finding'] ?? '';
  if (!/bug issue/.test(finding)) problems.push('a finding never becomes a bug issue');
  if (!/in writing/.test(finding)) problems.push('a finding is never accepted in writing');
  const label = /\b[ABCR]\d{1,2}\b|\bPR #\d+/.exec(pass.section);
  if (label) problems.push(`the section names a PR: ${label[0]}`);
  return problems;
}

/** The contract with the steps that carry one acceptance item taken out. */
export function withoutStep(contract, item) {
  const pass = ownerPass(contract);
  let text = contract;
  for (const step of pass?.steps[item.area] ?? []) {
    if (item.title.every((words) => words.test(step.title)) && item.body.every((words) => words.test(step.text))) text = text.replace(`${step.text}\n`, '');
  }
  return text;
}
