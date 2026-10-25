import { createHash } from 'node:crypto';
import path from 'node:path';
import { foldName } from '../foldName';
import { ASSET_REVISION_RE, canonicalJson, PHOTO_ID_RE, PROFILE_ID_RE } from '../identity/ids';
import type { TechnicalKey } from '../identity/metadata';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../identity/variants';
import { cameraSettingsCaption } from './legacy-photos';
import { ORDER_RULES } from './order-rules';
import { MAX_SLUG_LENGTH, RESERVED_SLUGS, SERIES_ID_RE, SLUG_RE } from './schema';
import type { Gate, Issue, IssueRecord, Rule, RuleContext, RuleFinding } from './types';

/**
 * The validation rule registry, #13's rules, and #8's order rules from
 * order-rules.ts. One rule per check, named under its group, and each rule's
 * ID is the code of the issues it reports. Other issues register their own
 * (#5's route.*, #15, #16), and registerRule() throws on an ID that is
 * already taken.
 */

const RULE_ID_RE = /^[a-z]+\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GATES: readonly Gate[] = ['render', 'publish'];

const rules = new Map<string, Rule>();

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function assertRule(rule: Rule): void {
    if (typeof rule?.id !== 'string' || !RULE_ID_RE.test(rule.id)) throw new TypeError(`A rule ID is <group>.<name> in lowercase, not ${JSON.stringify(rule?.id)}.`);
    if (!Number.isInteger(rule.version) || rule.version < 1) throw new TypeError(`${rule.id}: version must be a positive integer.`);
    if (rule.severity !== 'error' && rule.severity !== 'warning') throw new TypeError(`${rule.id}: severity must be error or warning.`);
    if (rule.rollbackClass !== 'integrity' && rule.rollbackClass !== 'editorial') throw new TypeError(`${rule.id}: rollbackClass must be integrity or editorial.`);
    if (!GATES.includes(rule.gate)) throw new TypeError(`${rule.id}: gate must be render or publish.`);
    if (typeof rule.check !== 'function') throw new TypeError(`${rule.id}: check must be a function.`);
}

/** Add a rule. Throws a TypeError on a malformed one, and an Error on an ID that is already registered. */
export function registerRule(rule: Rule): void {
    assertRule(rule);
    if (rules.has(rule.id)) throw new Error(`The rule ${rule.id} is already registered.`);
    rules.set(rule.id, Object.freeze({ ...rule }));
}

/** Every registered rule, sorted by ID. */
export function registeredRules(): Rule[] {
    return [...rules.values()].sort((a, b) => compare(a.id, b.id));
}

/** The SHA-256 hex of the rule IDs and versions, which each activation records. */
export function rulesetVersion(list: readonly Rule[] = registeredRules()): string {
    const entries = list.map((rule): [string, number] => [rule.id, rule.version]).sort(([a], [b]) => compare(a, b));
    return createHash('sha256').update(canonicalJson(entries)).digest('hex');
}

/** Values several rules share, worked out once per runRules() call. */
let running: { ctx: RuleContext; values: Map<string, unknown> } | null = null;

/** A value several rules share, worked out once per runRules() call, and afresh outside one. Rules registered elsewhere use it too. */
export function shared<T>(ctx: RuleContext, key: string, compute: () => T): T {
    if (running?.ctx !== ctx) return compute();
    if (!running.values.has(key)) running.values.set(key, compute());
    return running.values.get(key) as T;
}

function byIssue(a: Issue, b: Issue): number {
    return compare(a.record.kind, b.record.kind) || compare(a.record.id, b.record.id) || compare(a.field, b.field) || compare(a.code, b.code);
}

/** Run the registered rules in `gates` and return their issues sorted by record kind, record ID, field, and code. */
export function runRules(ctx: RuleContext, { gates = GATES }: { gates?: readonly Gate[] } = {}): Issue[] {
    const issues: Issue[] = [];
    const outer = running;
    running = { ctx, values: new Map() };
    try {
        for (const rule of registeredRules()) {
            if (!gates.includes(rule.gate)) continue;
            for (const finding of rule.check(ctx)) {
                issues.push({
                    code: rule.id,
                    severity: rule.severity,
                    record: finding.record,
                    field: finding.field,
                    message: finding.message,
                    ...(finding.hint ? { hint: finding.hint } : {}),
                });
            }
        }
    } finally {
        running = outer;
    }
    return issues.sort(byIssue);
}

// Records and series.

const SITE: IssueRecord = { kind: 'site', id: 'site' };
const seriesRecord = (id: string): IssueRecord => ({ kind: 'series', id });
const photoRecord = (id: string): IssueRecord => ({ kind: 'photo', id });

interface SeriesLike {
    id: string;
    slug: string;
    slugAliases: string[];
    title: string;
    statement: string;
    shortStatement: string;
    photoIds: string[];
    chapters: { id: string }[];
}

/** Every series: the working layer's, or a stored revision's. */
function allSeries(ctx: RuleContext): SeriesLike[] {
    return ctx.authored ? ctx.authored.series : ctx.candidate.series;
}

/** Published series: the working layer's, or a stored revision's, which holds only published ones. */
function publishedSeries(ctx: RuleContext): SeriesLike[] {
    return ctx.authored ? ctx.authored.series.filter((series) => series.visibility === 'published') : ctx.candidate.series;
}

/** A series' slug and aliases, with the field each sits in. */
function slugsOf(series: SeriesLike): [field: string, slug: string][] {
    return [['slug', series.slug], ...series.slugAliases.map((alias, index): [string, string] => [`slugAliases[${index}]`, alias])];
}

// Source file names.

const NON_ASCII_RE = /[\u0080-\uffff]/;
/**
 * Folded as foldName() folds a name, the way a case-insensitive disk compares
 * names, so Stra\u00dfe and STRASSE match. ASCII text only needs lowering.
 */
const lowered = (text: string) => (NON_ASCII_RE.test(text) ? foldName(text) : text.toLowerCase());

interface SourceNames {
    names: string[];
    stems: string[];
}

/** Each published photo's source base names, past and present, from the registry, folded. */
function sourceNames(ctx: RuleContext): Map<string, SourceNames> {
    return shared(ctx, 'sourceNames', () => {
        const byPhoto = new Map<string, SourceNames>();
        for (const photo of ctx.candidate.photos) {
            const record = ctx.registry?.photos[photo.id];
            if (!record) continue;
            const paths = [record.source.path, ...Object.values(record.revisions).map((revision) => revision.firstSeenPath)];
            const names = [...new Set(paths.filter(Boolean).map((value) => lowered(path.posix.basename(value))))];
            byPhoto.set(photo.id, { names, stems: names.map((name) => name.replace(/\.[^.]+$/, '')).filter(Boolean) });
        }
        return byPhoto;
    });
}

/**
 * Whether a text holds any of `names`. It looks for each name's extension
 * and checks the names of that length ending there, so thousands of names
 * over every published string stay cheap.
 */
function nameMatcher(names: Iterable<string>): (text: string) => boolean {
    const known = new Set<string>();
    const lengthsByExtension = new Map<string, Set<number>>();
    const bare: string[] = [];
    for (const name of names) {
        if (!name || known.has(name)) continue;
        known.add(name);
        const dot = name.lastIndexOf('.');
        if (dot <= 0 || dot === name.length - 1) {
            bare.push(name);
            continue;
        }
        const extension = name.slice(dot);
        const lengths = lengthsByExtension.get(extension) ?? new Set<number>();
        lengths.add(name.length);
        lengthsByExtension.set(extension, lengths);
    }
    const extensions = [...lengthsByExtension].map(([extension, lengths]) => ({ extension, lengths: [...lengths] }));
    return (text) => {
        for (const { extension, lengths } of extensions) {
            for (let at = text.indexOf(extension); at !== -1; at = text.indexOf(extension, at + 1)) {
                const end = at + extension.length;
                if (lengths.some((length) => length <= end && known.has(text.slice(end - length, end)))) return true;
            }
        }
        return bare.some((name) => text.includes(name));
    };
}

// Descriptions.

const normalized = (text: string) => lowered(text).trim().replace(/\s+/g, ' ');
const PLACEHOLDER_RE = /^(?:gallery image \d+|slide \d+|photograph \d+|open photograph)[.!]?$/;
const MAX_DESCRIPTION = 250;

const BEFORE = '(?<![\\p{L}\\p{N}])';
const AFTER = '(?![\\p{L}\\p{N}])';
/** Focal length, aperture, shutter speed, and ISO, as in `35mm`, `f/1.8`, `1/200s`, and `ISO 100`. */
const SETTING = '(?:\\d+(?:\\.\\d+)?\\s?mm|f\\/\\d+(?:\\.\\d+)?|\\d+\\/\\d+\\s?s|iso\\s?\\d+)';
const SETTING_RE = new RegExp(`${BEFORE}${SETTING}${AFTER}`, 'iu');
const SETTINGS_RE = new RegExp(`${BEFORE}${SETTING}${AFTER}`, 'giu');
/** What may be left of a text once its camera tokens are gone, for it to count as only camera tokens: digits, separators, bullets, and dashes. */
const LEFTOVER_RE = /^[\s\d.,;:|/()\u00b7\u2022\u2013\u2014-]*$/u;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Built patterns by camera, since a library holds a few cameras and thousands of photos. */
const cameraPatterns = new Map<string, RegExp | null>();

/**
 * The photo's make, model, and lens, and its own shutter speed as the legacy
 * caption writes it, such as `2s` or `1.5s`, which SETTING misses, as whole
 * words, longest first.
 */
function cameraNames(technical: Partial<Record<TechnicalKey, string>>): RegExp | null {
    const names = [technical.Make, technical.Model, technical.LensModel, technical.ExposureTime && `${technical.ExposureTime}s`]
        .map((value) => value?.normalize('NFC').trim())
        .filter((value): value is string => Boolean(value))
        .sort((a, b) => b.length - a.length);
    const key = JSON.stringify(names);
    let pattern = cameraPatterns.get(key);
    if (pattern === undefined) {
        pattern = names.length ? new RegExp(`${BEFORE}(?:${names.map(escapeRegExp).join('|')})${AFTER}`, 'giu') : null;
        if (cameraPatterns.size >= 256) cameraPatterns.clear();
        cameraPatterns.set(key, pattern);
    }
    return pattern;
}

/** Whether the text holds camera tokens and nothing else but numbers and separators. */
function onlyCameraTokens(text: string, technical: Partial<Record<TechnicalKey, string>>): boolean {
    let found = false;
    const drop = () => {
        found = true;
        return ' ';
    };
    let rest = text.normalize('NFC');
    const names = cameraNames(technical);
    if (names) rest = rest.replace(names, drop);
    rest = rest.replace(SETTINGS_RE, drop);
    return found && LEFTOVER_RE.test(rest);
}

function holdsCameraToken(text: string, technical: Partial<Record<TechnicalKey, string>>): boolean {
    const value = text.normalize('NFC');
    const names = cameraNames(technical);
    return SETTING_RE.test(value) || value.includes('|') || (names !== null && value.search(names) !== -1);
}

interface DescribedPhoto {
    id: string;
    text: string;
    technical: Partial<Record<TechnicalKey, string>>;
    blank: boolean;
    filename: boolean;
    placeholder: boolean;
    cameraOnly: boolean;
}

/** The candidate's described photos, with the error checks worked out once. */
function describedPhotos(ctx: RuleContext): DescribedPhoto[] {
    return shared(ctx, 'describedPhotos', () => {
        const names = sourceNames(ctx);
        return ctx.candidate.photos.flatMap((photo): DescribedPhoto[] => {
            if (photo.alt.kind !== 'described') return [];
            const text = photo.alt.text;
            const value = normalized(text);
            // Nothing a screen reader would say, such as `...` or a zero-width space. A flag's regional
            // indicators and a keycap's enclosing mark (U+20E3) count as content.
            const blank = !/[\p{L}\p{N}\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u.test(value);
            const source = names.get(photo.id);
            return [{
                id: photo.id,
                text,
                technical: photo.technical,
                blank,
                filename: !blank && source !== undefined && (source.names.includes(value) || source.stems.includes(value)),
                placeholder: PLACEHOLDER_RE.test(value),
                cameraOnly: !blank && (value === normalized(cameraSettingsCaption(photo.technical)) || onlyCameraTokens(text, photo.technical)),
            }];
        });
    });
}

/** An error check already refuses the text, so the warnings stay quiet about it. */
const refused = (photo: DescribedPhoto) => photo.blank || photo.filename || photo.placeholder || photo.cameraOnly;

const describedIssue = (photo: DescribedPhoto, message: string, hint?: string): RuleFinding => ({
    record: photoRecord(photo.id),
    field: 'alt.text',
    message,
    ...(hint ? { hint } : {}),
});

const DESCRIBE_HINT = 'Describe what the photograph shows.';

// Published values.

const unanchored = (re: RegExp) => re.source.replace(/^\^/, '').replace(/\$$/, '');
const MEDIA_URL_RE = new RegExp(
    `^/media/${unanchored(PHOTO_ID_RE)}/${unanchored(ASSET_REVISION_RE)}/${unanchored(PROFILE_ID_RE)}/(?:${VARIANT_WIDTHS.join('|')})\\.(?:${VARIANT_FORMATS.join('|')})$`,
);
const VARIANT_URL_FIELD_RE = /^variants\.w\d+\.[a-z]+\.url$/;
const LQIP_RE = /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/;
const PRIVATE_KEY_RE = /gps|serial|owner/i;

/** Media URLs and the LQIP data URI are generated from IDs and pixels, so the text checks skip them. */
function isGenerated(field: string, value: string): boolean {
    if (field === 'lqip') return LQIP_RE.test(value);
    return value.startsWith('/media/') && VARIANT_URL_FIELD_RE.test(field) && MEDIA_URL_RE.test(value);
}

interface PublishedString {
    record: IssueRecord;
    field: string;
    value: string;
}

interface PublishedValues {
    /** Every string in the candidate a visitor could read, with its record and field. */
    strings: PublishedString[];
    /** Every key that names a GPS, serial, or owner field. */
    privateKeys: { record: IssueRecord; field: string }[];
}

/** One walk over the candidate for the privacy rules. It builds a field path only where a finding could need it. */
function publishedValues(ctx: RuleContext): PublishedValues {
    return shared(ctx, 'publishedValues', () => {
        const values: PublishedValues = { strings: [], privateKeys: [] };
        const visit = (record: IssueRecord, value: unknown, field: string): void => {
            if (typeof value === 'string') {
                if (!isGenerated(field, value)) values.strings.push({ record, field, value });
                return;
            }
            if (typeof value !== 'object' || value === null) return;
            if (Array.isArray(value)) {
                value.forEach((item, index) => {
                    if (typeof item === 'string' || (typeof item === 'object' && item !== null)) visit(record, item, `${field}[${index}]`);
                });
                return;
            }
            for (const [name, inner] of Object.entries(value)) {
                const flagged = PRIVATE_KEY_RE.test(name);
                if (!flagged && typeof inner !== 'string' && (typeof inner !== 'object' || inner === null)) continue;
                const child = field ? `${field}.${name}` : name;
                if (flagged) values.privateKeys.push({ record, field: child });
                visit(record, inner, child);
            }
        };
        visit(SITE, ctx.candidate.site, '');
        for (const series of ctx.candidate.series) visit(seriesRecord(series.id), series, '');
        for (const photo of ctx.candidate.photos) visit(photoRecord(photo.id), photo, '');
        return values;
    });
}

/** Every PATH_LIKE_RE match holds one of these, so most strings skip the full pattern. */
const MAYBE_PATH_RE = /[\\/:]|^\.\.$/;
/** A common absolute path, a home-relative one, a Windows drive, a file: URL, or a `..` segment. */
const PATH_LIKE_RE = /\/(?:users|home|data|volumes|mnt)\/|(?<![\p{L}\p{N}])~\/|(?<![\p{L}\p{N}])[a-z]:[\\/]|(?<![\p{L}\p{N}])file:|(?:^|[\\/])\.\.(?:[\\/]|$)/iu;

/** A path folded as a case-insensitive disk compares it, with each run of slashes or backslashes as one `/`. */
const foldedPath = (text: string) => lowered(text).replace(/[\\/]+/g, '/');

/** Characters a reader doesn't see: format characters and the default-ignorable ones, such as a soft hyphen, ZWJ, or a tag. */
const INVISIBLE_RE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/** `text`, and `text` without its invisible characters when it has any, so one can't split a path or a name past a check. */
function readings(text: string): string[] {
    const visible = text.replace(INVISIBLE_RE, '');
    return visible === text ? [text] : [text, visible];
}

/** Whether `text` holds `root` as a whole path: not followed by more of a name, so `/data` doesn't match `/database`. Both come folded. */
function holdsRoot(text: string, root: string): boolean {
    for (let at = text.indexOf(root); at !== -1; at = text.indexOf(root, at + 1)) {
        if (!/[\p{L}\p{N}_-]/u.test(text.charAt(at + root.length))) return true;
    }
    return false;
}

// Accents.

/** The Viewer bands an accent has to stand out against, as #21 declares `--cc-band-edge` and `--cc-band-mid`. */
export const BAND_COLORS = ['#101413', '#151918'] as const;
const ACCENT_RE = /^#[0-9a-f]{6}$/i;
const MIN_ACCENT_CONTRAST = 3;

/** WCAG relative luminance. */
function luminance(hex: string): number {
    const [r, g, b] = [1, 3, 5].map((start) => {
        const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
    const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (lighter + 0.05) / (darker + 0.05);
}

/** Accents a visitor would see: on published series and photos. */
function accents(ctx: RuleContext): { record: IssueRecord; accent: string }[] {
    return [
        ...ctx.candidate.series.flatMap((series) => (series.accent !== undefined ? [{ record: seriesRecord(series.id), accent: series.accent }] : [])),
        ...ctx.candidate.photos.flatMap((photo) => (photo.accent !== undefined ? [{ record: photoRecord(photo.id), accent: photo.accent }] : [])),
    ];
}

// The rules.

type RuleDefinition = Omit<Rule, 'version' | 'rollbackClass'> & Partial<Pick<Rule, 'version' | 'rollbackClass'>>;

/** Working-layer files with one of `reasons`, one finding per schema issue. */
function problemsWith(ctx: RuleContext, reasons: readonly string[], hint: (reason: string) => string): RuleFinding[] {
    return (ctx.authored?.problems ?? [])
        .filter((problem) => reasons.includes(problem.reason))
        .flatMap((problem) => problem.issues.map((issue) => ({
            record: { kind: problem.kind, id: problem.id },
            field: issue.path,
            message: issue.message,
            hint: hint(problem.reason),
        })));
}

const STRUCTURE_HINTS: Record<string, string> = {
    invalid: 'Fix the field so the record matches the catalog schema.',
    'invalid-json': 'Fix the JSON syntax.',
    unreadable: 'Check the file\'s permissions.',
    'edited-in-place': 'Never edit a version in place. Copy the newest version to the next number and edit the copy, while no command runs.',
};

const SLICE_A_RULES: RuleDefinition[] = [
    {
        id: 'structure.schema',
        severity: 'error',
        gate: 'render',
        check: (ctx) => problemsWith(ctx, ['invalid', 'invalid-json', 'unreadable', 'edited-in-place'], (reason) => STRUCTURE_HINTS[reason]),
    },
    {
        id: 'structure.schema-version',
        severity: 'error',
        gate: 'render',
        check: (ctx) => problemsWith(ctx, ['unknown-schema-version'], () => 'A newer build wrote this record. Run that build, or restore the record from a backup.'),
    },
    {
        id: 'structure.file-name',
        severity: 'error',
        gate: 'render',
        check: (ctx) => problemsWith(ctx, ['file-name'], () => 'Name the record\'s folder after its id, or fix the id.'),
    },
    {
        id: 'structure.series-id',
        severity: 'error',
        gate: 'render',
        check: (ctx) => allSeries(ctx).filter((series) => !SERIES_ID_RE.test(series.id)).map((series) => ({
            record: seriesRecord(series.id),
            field: 'id',
            message: 'A series ID is ser_ and then 2 to 63 lowercase letters, digits, hyphens, or underscores.',
        })),
    },
    {
        id: 'structure.chapter-id',
        severity: 'error',
        gate: 'render',
        check: (ctx) => allSeries(ctx).flatMap((series) => {
            const seen = new Set<string>();
            return series.chapters.flatMap((chapter, index) => {
                if (!seen.has(chapter.id)) {
                    seen.add(chapter.id);
                    return [];
                }
                return [{ record: seriesRecord(series.id), field: `chapters[${index}].id`, message: 'An earlier chapter in this series has the same ID.' }];
            });
        }),
    },
    {
        id: 'refs.featured',
        severity: 'error',
        gate: 'render',
        check: (ctx) => {
            const featured = ctx.authored ? ctx.authored.site?.featuredSeriesIds ?? [] : ctx.candidate.site.featuredSeriesIds;
            const published = new Set(publishedSeries(ctx).map((series) => series.id));
            const seen = new Set<string>();
            return featured.flatMap((seriesId, index) => {
                const field = `featuredSeriesIds[${index}]`;
                if (seen.has(seriesId)) return [{ record: SITE, field, message: `${seriesId} is featured twice.` }];
                seen.add(seriesId);
                return published.has(seriesId) ? [] : [{ record: SITE, field, message: `${seriesId} is not a published series.` }];
            });
        },
    },
    {
        id: 'refs.series-order',
        severity: 'error',
        gate: 'render',
        check: (ctx) => {
            // A stored revision's series are in Work order already, and a broken site record is structure.schema's.
            if (!ctx.authored || ctx.authored.problems.some((problem) => problem.kind === 'site')) return [];
            const known = new Set([
                ...ctx.authored.series.map((series) => series.id),
                // A misnamed folder entry is not a series ID, so it names no series.
                ...ctx.authored.problems.filter((problem) => problem.kind === 'series' && SERIES_ID_RE.test(problem.id)).map((problem) => problem.id),
            ]);
            const seen = new Set<string>();
            const findings: RuleFinding[] = (ctx.authored.site?.seriesOrder ?? []).flatMap((seriesId, index) => {
                const field = `seriesOrder[${index}]`;
                if (seen.has(seriesId)) return [{ record: SITE, field, message: `${seriesId} is listed twice.` }];
                seen.add(seriesId);
                return known.has(seriesId) ? [] : [{ record: SITE, field, message: `${seriesId} names no series.` }];
            });
            for (const series of publishedSeries(ctx)) {
                if (!seen.has(series.id)) findings.push({ record: SITE, field: 'seriesOrder', message: `The published series ${series.id} has no place in the Work order.`, hint: 'Add it to seriesOrder.' });
            }
            return findings;
        },
    },
    {
        id: 'refs.non-empty',
        severity: 'error',
        gate: 'publish',
        check: (ctx) => {
            const compiled = new Set(ctx.candidate.series.map((series) => series.id));
            const findings: RuleFinding[] = [];
            if (compiled.size === 0) findings.push({ record: SITE, field: 'seriesOrder', message: 'No series would be published.' });
            if (!ctx.candidate.site.featuredSeriesIds.some((seriesId) => compiled.has(seriesId))) {
                findings.push({ record: SITE, field: 'featuredSeriesIds', message: 'No featured series would be published, so Home has nothing to open on.' });
            }
            return findings;
        },
    },
    {
        id: 'refs.membership',
        severity: 'error',
        gate: 'render',
        check: (ctx) => {
            const seriesByPhoto = new Map<string, string[]>();
            for (const series of publishedSeries(ctx)) {
                for (const photoId of new Set(series.photoIds)) seriesByPhoto.set(photoId, [...(seriesByPhoto.get(photoId) ?? []), series.id]);
            }
            return [...seriesByPhoto].filter(([, ids]) => ids.length > 1).map(([photoId, ids]) => ({
                record: photoRecord(photoId),
                field: 'series',
                message: `The photograph is in more than one published series: ${ids.join(', ')}.`,
                hint: 'A photograph belongs to at most one published series. Remove it from all but one.',
            }));
        },
    },
    {
        id: 'description.required',
        severity: 'error',
        gate: 'publish',
        check: (ctx) => {
            const authored = new Map((ctx.authored?.photos ?? []).map((photo) => [photo.id, photo]));
            return ctx.candidate.photos.flatMap((photo) => {
                if (photo.alt.kind === 'pending') {
                    return [{ record: photoRecord(photo.id), field: 'alt', message: 'The photograph has no description.', hint: 'Describe it, or mark it decorative.' }];
                }
                // A stored revision has no reviewed flag to check.
                const alt = authored.get(photo.id)?.alt;
                if (photo.alt.kind === 'described' && alt?.kind === 'described' && !alt.reviewed) {
                    return [{ record: photoRecord(photo.id), field: 'alt', message: 'Nobody has reviewed this suggested description yet.', hint: 'Read it, fix it if needed, then set reviewed to true.' }];
                }
                return [];
            });
        },
    },
    {
        id: 'description.empty',
        severity: 'error',
        gate: 'publish',
        check: (ctx) => describedPhotos(ctx).filter((photo) => photo.blank).map((photo) => describedIssue(photo, 'The description has no letters, digits, or emoji.', DESCRIBE_HINT)),
    },
    {
        id: 'description.filename',
        severity: 'error',
        gate: 'publish',
        check: (ctx) => describedPhotos(ctx).filter((photo) => photo.filename).map((photo) => describedIssue(photo, 'The description is the source file\'s name.', DESCRIBE_HINT)),
    },
    {
        id: 'description.placeholder',
        severity: 'error',
        gate: 'publish',
        check: (ctx) => describedPhotos(ctx).filter((photo) => photo.placeholder).map((photo) => describedIssue(photo, 'The description is a placeholder.', DESCRIBE_HINT)),
    },
    {
        id: 'description.camera-caption',
        severity: 'error',
        gate: 'publish',
        check: (ctx) => describedPhotos(ctx).filter((photo) => photo.cameraOnly).map((photo) => describedIssue(
            photo,
            'The description is only camera details, which say nothing about what the photograph shows.',
            DESCRIBE_HINT,
        )),
    },
    {
        id: 'description.camera-tokens',
        severity: 'warning',
        gate: 'publish',
        check: (ctx) => describedPhotos(ctx).filter((photo) => !refused(photo) && holdsCameraToken(photo.text, photo.technical)).map((photo) => describedIssue(
            photo,
            'The description mentions camera details.',
            'Screen readers read the description aloud. The camera details are stored separately.',
        )),
    },
    {
        id: 'description.length',
        severity: 'warning',
        gate: 'publish',
        check: (ctx) => describedPhotos(ctx).flatMap((photo) => {
            const length = [...photo.text.trim()].length;
            if (refused(photo) || length <= MAX_DESCRIPTION) return [];
            return [describedIssue(photo, `The description runs ${length} characters, past ${MAX_DESCRIPTION}.`, 'Keep it to what the photograph shows.')];
        }),
    },
    {
        id: 'description.series-copy',
        severity: 'error',
        gate: 'publish',
        check: (ctx) => publishedSeries(ctx).flatMap((series) => (['title', 'statement', 'shortStatement'] as const)
            .filter((field) => !/\S/.test(series[field]))
            .map((field) => ({
                record: seriesRecord(series.id),
                field,
                message: `A published series needs a ${field === 'shortStatement' ? 'short statement' : field}.`,
            }))),
    },
    {
        id: 'route.slug-format',
        severity: 'error',
        gate: 'render',
        check: (ctx) => allSeries(ctx).flatMap((series) => slugsOf(series)
            .filter(([, slug]) => !SLUG_RE.test(slug) || slug.length > MAX_SLUG_LENGTH)
            .map(([field]) => ({
                record: seriesRecord(series.id),
                field,
                message: `A slug is lowercase letters and digits in words joined by single hyphens, at most ${MAX_SLUG_LENGTH} characters.`,
            }))),
    },
    {
        id: 'route.reserved',
        severity: 'error',
        gate: 'render',
        check: (ctx) => allSeries(ctx).flatMap((series) => slugsOf(series)
            .filter(([, slug]) => (RESERVED_SLUGS as readonly string[]).includes(slug))
            .map(([field, slug]) => ({ record: seriesRecord(series.id), field, message: `${slug} is reserved for the site's own routes.` }))),
    },
    {
        id: 'route.collision',
        severity: 'error',
        gate: 'render',
        check: (ctx) => {
            const users = new Map<string, { seriesId: string; field: string }[]>();
            for (const series of allSeries(ctx)) {
                for (const [field, slug] of slugsOf(series)) users.set(slug, [...(users.get(slug) ?? []), { seriesId: series.id, field }]);
            }
            return [...users.values()].filter((entries) => entries.length > 1).flatMap((entries) => entries.map((entry) => {
                const others = [...new Set(entries.filter((other) => other.seriesId !== entry.seriesId).map((other) => other.seriesId))];
                return {
                    record: seriesRecord(entry.seriesId),
                    field: entry.field,
                    message: others.length ? `The slug is also used by ${others.join(', ')}.` : 'The slug is used twice in this series.',
                };
            }));
        },
    },
    {
        id: 'accent.format',
        severity: 'error',
        gate: 'publish',
        rollbackClass: 'editorial',
        check: (ctx) => accents(ctx).filter(({ accent }) => !ACCENT_RE.test(accent)).map(({ record }) => ({
            record,
            field: 'accent',
            message: 'An accent is a #rrggbb color.',
        })),
    },
    {
        id: 'accent.contrast',
        severity: 'error',
        gate: 'publish',
        rollbackClass: 'editorial',
        check: (ctx) => accents(ctx)
            .filter(({ accent }) => ACCENT_RE.test(accent) && BAND_COLORS.some((band) => contrast(accent, band) < MIN_ACCENT_CONTRAST))
            .map(({ record, accent }) => ({
                record,
                field: 'accent',
                message: `${accent} has less than ${MIN_ACCENT_CONTRAST}:1 contrast against the Viewer's dark bands.`,
                hint: 'Pick a lighter color.',
            })),
    },
    {
        id: 'privacy.path',
        severity: 'error',
        gate: 'render',
        check: (ctx) => {
            const roots = [ctx.roots.dataRoot, ctx.roots.libraryRoot]
                .map((root) => (root ? foldedPath(root).replace(/\/$/, '') : ''))
                .filter(Boolean);
            return publishedValues(ctx).strings
                .filter(({ value }) => readings(value).some((text) => (MAYBE_PATH_RE.test(text) && PATH_LIKE_RE.test(text)) || roots.some((root) => holdsRoot(foldedPath(text), root))))
                .map(({ record, field }) => ({ record, field, message: 'The field holds what looks like a file path.', hint: 'Published text never names a path.' }));
        },
    },
    {
        id: 'privacy.source-name',
        severity: 'error',
        gate: 'render',
        check: (ctx) => {
            const holdsName = nameMatcher([...sourceNames(ctx).values()].flatMap((entry) => entry.names));
            return publishedValues(ctx).strings
                .filter(({ value }) => readings(value).some((text) => holdsName(lowered(text))))
                .map(({ record, field }) => ({ record, field, message: 'The field holds a source file\'s name.', hint: 'Published text never names a source file.' }));
        },
    },
    {
        id: 'privacy.private-key',
        severity: 'error',
        gate: 'render',
        check: (ctx) => publishedValues(ctx).privateKeys.map(({ record, field }) => ({
            record,
            field,
            message: 'GPS positions, serial numbers, and owner names never reach a visitor.',
        })),
    },
    {
        id: 'working.conflicts',
        severity: 'error',
        gate: 'publish',
        check: (ctx) => {
            if (!ctx.authored) return [];
            const records: { record: IssueRecord; conflicts?: { field: string }[] }[] = [
                ...(ctx.authored.site ? [{ record: SITE, conflicts: ctx.authored.site.conflicts }] : []),
                ...ctx.authored.series.map((series) => ({ record: seriesRecord(series.id), conflicts: series.conflicts })),
                ...ctx.authored.photos.map((photo) => ({ record: photoRecord(photo.id), conflicts: photo.conflicts })),
            ];
            return records.flatMap(({ record, conflicts }) => (conflicts ?? []).map((conflict) => ({
                record,
                field: conflict.field,
                message: 'This field changed both here and in the active revision, in different ways.',
                hint: 'Settle the field, then delete its conflicts entry.',
            })));
        },
    },
];

for (const definition of SLICE_A_RULES) registerRule({ version: 1, rollbackClass: 'integrity', ...definition });
// #8's sequence rules. A stand-in registered under one of these IDs now throws.
for (const orderRule of ORDER_RULES) registerRule(orderRule);
