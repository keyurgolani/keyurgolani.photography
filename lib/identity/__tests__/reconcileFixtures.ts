/**
 * Synthetic libraries for reconcile() table tests: a scan and its inspections
 * built in memory, so every row, including ones a case-insensitive disk
 * can't hold, runs the same everywhere. Digests are SHA-256 of labels.
 */

import { createHash } from 'node:crypto';
import { emptyTiers } from '../metadata';
import type { ImageInspection, Inspection } from '../inspect';
import { reconcile, type ReconcileResult } from '../reconcile';
import { keyOf, type LibraryScan, type ScanEntry } from '../scan';
import { emptyRegistry, type Registry } from '../types';

export const NOW = Date.parse('2026-06-01T12:00:00.000Z');
export const PROFILE = 'p_00000000000000aa';

export function digest(label: string): string {
    return `sha256-${createHash('sha256').update(label).digest('hex')}`;
}

/** An image whose bytes are `bytes`. Its pixels default to the same label, so two files differ in pixels unless told otherwise. */
export function image(bytes: string, { pixels = bytes, size = 1_000 }: { pixels?: string | null; size?: number } = {}): ImageInspection {
    const tiers = emptyTiers();
    return {
        kind: 'image',
        assetRevision: digest(`bytes:${bytes}`),
        sourceBytes: size,
        pixelDigest: pixels === null ? null : digest(`pixels:${pixels}`),
        sourceFormat: 'jpeg',
        width: pixels === null ? null : 960,
        height: pixels === null ? null : 640,
        orientation: null,
        derived: tiers.derived,
        curatorOnly: tiers.curatorOnly,
        ...(pixels === null ? { decodeError: 'unsupported image format' } : {}),
    };
}

export function revisionOf(bytes: string): string {
    return digest(`bytes:${bytes}`);
}

interface FileState {
    inspection: Inspection;
    kind: ScanEntry['kind'];
    mtimeMs: number;
    ctimeMs: number;
    ino: number;
}

/** A sequence of UUID v4s: 00000000-0000-4000-8000-000000000001 and up. */
export function sequentialIds(start = 1): () => string {
    let next = start;
    return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`;
}

export class FakeLibrary {
    private files = new Map<string, FileState>();
    private nextIno = 1;
    readonly unreadableDirs: string[] = [];
    readonly inspected: string[] = [];

    /** Put a file at `path`. `fresh` makes it look modified, renamed, or copied a moment ago. */
    put(path: string, inspection: Inspection, { fresh = false, kind = 'source' }: { fresh?: boolean; kind?: ScanEntry['kind'] } = {}): this {
        const changed = fresh ? NOW - 1_000 : NOW - 60_000;
        this.files.set(path, { inspection, kind, mtimeMs: NOW - 60_000, ctimeMs: changed, ino: this.nextIno++ });
        return this;
    }

    /** Rename keeps the inode and mtime. `fresh` marks its ctime as just changed, as a real rename does. */
    move(from: string, to: string, { fresh = false }: { fresh?: boolean } = {}): this {
        const file = this.files.get(from);
        if (!file) throw new Error(`No file at ${from}`);
        this.files.delete(from);
        this.files.set(to, { ...file, ctimeMs: fresh ? NOW - 1_000 : file.ctimeMs });
        return this;
    }

    remove(...paths: string[]): this {
        for (const path of paths) this.files.delete(path);
        return this;
    }

    /** Let time pass: every file is older than the stability window. */
    settle(): this {
        for (const file of this.files.values()) file.ctimeMs = Math.min(file.ctimeMs, NOW - 60_000);
        return this;
    }

    scan(): LibraryScan {
        const entries = [...this.files.entries()]
            .map(([path, file]): ScanEntry => ({
                path,
                key: keyOf(path),
                kind: file.kind,
                size: file.inspection.kind === 'image' || file.inspection.kind === 'unsupported' ? file.inspection.sourceBytes : 1,
                mtimeMs: file.mtimeMs,
                ctimeMs: file.ctimeMs,
                ino: file.ino,
            }))
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        return { root: '/library', observedAt: NOW, entries, unreadableDirs: [...this.unreadableDirs] };
    }

    lookup = (entry: ScanEntry): Inspection | undefined => {
        this.inspected.push(entry.path);
        return this.files.get(entry.path)?.inspection;
    };
}

/** Runs passes against one evolving registry, the way the watcher does. */
export class Reconciler {
    registry: Registry = emptyRegistry();
    readonly ids = sequentialIds();
    last!: ReconcileResult;

    constructor(readonly library = new FakeLibrary()) {}

    pass(): ReconcileResult {
        this.last = reconcile(this.library.scan(), this.registry, this.library.lookup, { idGen: this.ids, profileId: PROFILE });
        this.registry = { ...this.last.registry, version: this.registry.version + 1 };
        return this.last;
    }

    /** The photo bound to `path`, or the one whose last path it was. */
    photoAt(path: string) {
        const photo = Object.values(this.registry.photos).find((candidate) => candidate.source.path === path);
        if (!photo) throw new Error(`No photo at ${path}`);
        return photo;
    }

    photo(photoId: string) {
        const photo = this.registry.photos[photoId];
        if (!photo) throw new Error(`No photo ${photoId}`);
        return photo;
    }

    /** The facts of the last pass as `type path` strings, sorted. */
    factSummary(): string[] {
        return this.last.facts.map((fact) => `${fact.type} ${fact.path}`).sort();
    }
}
