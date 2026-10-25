import { gzipSync } from 'node:zlib';

/** A read model's size as it would leave the server. Node only. */
export interface PayloadSize {
    /** UTF-8 bytes of `JSON.stringify(model)`. */
    bytes: number;
    /** The same bytes through `gzipSync` at zlib's default level. */
    gzipBytes: number;
}

export function payloadSize(model: unknown): PayloadSize {
    const json = Buffer.from(JSON.stringify(model), 'utf8');
    return { bytes: json.length, gzipBytes: gzipSync(json).length };
}

/** A shipped image: anything in a model that carries a variant ladder. */
export interface ShippedImage {
    width: unknown;
    height: unknown;
    variants: unknown;
}

/** Every image in `model`, depth first, so a test can count photo records and check their geometry. */
export function imagesIn(model: unknown): ShippedImage[] {
    const found: ShippedImage[] = [];
    const walk = (value: unknown) => {
        if (Array.isArray(value)) {
            value.forEach(walk);
        } else if (typeof value === 'object' && value !== null) {
            if ('variants' in value) found.push(value as ShippedImage);
            Object.values(value).forEach(walk);
        }
    };
    walk(model);
    return found;
}

/** How many arrays `model` holds at any depth, itself included, so a test can tell a sequence from a single record. */
export function arraysIn(model: unknown): number {
    let count = 0;
    const walk = (value: unknown) => {
        if (Array.isArray(value)) {
            count += 1;
            value.forEach(walk);
        } else if (typeof value === 'object' && value !== null) {
            Object.values(value).forEach(walk);
        }
    };
    walk(model);
    return count;
}
