/**
 * Builds JPEGs carrying metadata Sharp can't write: a full EXIF block with
 * MakerNote, serial numbers, an owner name, GPS, and an embedded thumbnail,
 * plus XMP and IPTC segments. Generated at test time, so no binaries are
 * committed.
 */

import sharp from 'sharp';

export type TiffValue =
    | { type: 'ascii'; value: string }
    | { type: 'byte'; value: number[] }
    | { type: 'short'; value: number[] }
    | { type: 'long'; value: number[] }
    | { type: 'rational'; value: [number, number][] }
    | { type: 'undefined'; value: Buffer };

export type Ifd = Record<number, TiffValue>;

const TYPE_CODE = { byte: 1, ascii: 2, short: 3, long: 4, rational: 5, undefined: 7 } as const;
const UNIT = { byte: 1, ascii: 1, short: 2, long: 4, rational: 8, undefined: 1 } as const;

const EXIF_POINTER = 0x8769;
const GPS_POINTER = 0x8825;
const THUMBNAIL_OFFSET = 0x0201;
const THUMBNAIL_LENGTH = 0x0202;

function encode(value: TiffValue): Buffer {
    switch (value.type) {
        case 'ascii':
            return Buffer.from(`${value.value}\0`, 'latin1');
        case 'undefined':
            return value.value;
        case 'byte':
            return Buffer.from(value.value);
        case 'short': {
            const out = Buffer.alloc(value.value.length * 2);
            value.value.forEach((n, i) => out.writeUInt16BE(n, i * 2));
            return out;
        }
        case 'long': {
            const out = Buffer.alloc(value.value.length * 4);
            value.value.forEach((n, i) => out.writeUInt32BE(n, i * 4));
            return out;
        }
        case 'rational': {
            const out = Buffer.alloc(value.value.length * 8);
            value.value.forEach(([numerator, denominator], i) => {
                out.writeUInt32BE(numerator, i * 8);
                out.writeUInt32BE(denominator, i * 8 + 4);
            });
            return out;
        }
    }
}

function countOf(value: TiffValue): number {
    return encode(value).length / UNIT[value.type];
}

/** Bytes an IFD takes with its out-of-line values, each padded to an even length. */
function sizeOf(ifd: Ifd): number {
    const tags = Object.keys(ifd);
    let size = 2 + tags.length * 12 + 4;
    for (const tag of tags) {
        const length = encode(ifd[Number(tag)]).length;
        if (length > 4) size += length + (length % 2);
    }
    return size;
}

function writeIfd(ifd: Ifd, start: number, nextIfd: number): Buffer {
    const out = Buffer.alloc(sizeOf(ifd));
    const tags = Object.keys(ifd).map(Number).sort((a, b) => a - b);
    out.writeUInt16BE(tags.length, 0);
    let data = 2 + tags.length * 12 + 4;
    tags.forEach((tag, i) => {
        const value = ifd[tag];
        const bytes = encode(value);
        const at = 2 + i * 12;
        out.writeUInt16BE(tag, at);
        out.writeUInt16BE(TYPE_CODE[value.type], at + 2);
        out.writeUInt32BE(countOf(value), at + 4);
        if (bytes.length <= 4) {
            bytes.copy(out, at + 8);
        } else {
            out.writeUInt32BE(start + data, at + 8);
            bytes.copy(out, data);
            data += bytes.length + (bytes.length % 2);
        }
    });
    out.writeUInt32BE(nextIfd, 2 + tags.length * 12);
    return out;
}

/** A big-endian TIFF block, prefixed `Exif\0\0` as JPEG APP1 stores it. IFD1 carries `thumbnail`. */
export function buildExif({ ifd0, exif, gps, thumbnail }: { ifd0: Ifd; exif: Ifd; gps: Ifd; thumbnail: Buffer }): Buffer {
    const zero: TiffValue = { type: 'long', value: [0] };
    const ifd1: Ifd = {
        0x0103: { type: 'short', value: [6] },
        [THUMBNAIL_OFFSET]: zero,
        [THUMBNAIL_LENGTH]: { type: 'long', value: [thumbnail.length] },
    };
    const first: Ifd = { ...ifd0, [EXIF_POINTER]: zero, [GPS_POINTER]: zero };

    const ifd0At = 8;
    const exifAt = ifd0At + sizeOf(first);
    const gpsAt = exifAt + sizeOf(exif);
    const ifd1At = gpsAt + sizeOf(gps);
    const thumbnailAt = ifd1At + sizeOf(ifd1);
    first[EXIF_POINTER] = { type: 'long', value: [exifAt] };
    first[GPS_POINTER] = { type: 'long', value: [gpsAt] };
    ifd1[THUMBNAIL_OFFSET] = { type: 'long', value: [thumbnailAt] };

    const header = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]);
    return Buffer.concat([
        Buffer.from('Exif\0\0', 'latin1'),
        header,
        writeIfd(first, ifd0At, ifd1At),
        writeIfd(exif, exifAt, 0),
        writeIfd(gps, gpsAt, 0),
        writeIfd(ifd1, ifd1At, 0),
        thumbnail,
    ]);
}

function segment(marker: number, payload: Buffer): Buffer {
    const header = Buffer.from([0xff, marker, 0x00, 0x00]);
    header.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([header, payload]);
}

/** An XMP APP1 payload holding `fields` as Dublin Core and custom properties. */
export function xmpPayload(fields: Record<string, string>): Buffer {
    const properties = Object.entries(fields).map(([name, value]) => `<${name}>${value}</${name}>`).join('');
    const packet = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">' +
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" ' +
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:fx="http://example.com/fixture/">' +
        `${properties}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    return Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(packet, 'utf8')]);
}

/** A Photoshop APP13 payload with one IPTC By-line dataset. */
export function iptcPayload(byline: string): Buffer {
    const text = Buffer.from(byline, 'utf8');
    const dataset = Buffer.concat([Buffer.from([0x1c, 0x02, 0x50, text.length >> 8, text.length & 0xff]), text]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(dataset.length);
    const block = Buffer.concat([Buffer.from('8BIM', 'latin1'), Buffer.from([0x04, 0x04, 0x00, 0x00]), size, dataset]);
    return Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), block, Buffer.alloc(block.length % 2)]);
}

/** Insert APP segments right after SOI, and after a JFIF APP0 if there is one. */
export function withSegments(jpeg: Buffer, segments: { marker: number; payload: Buffer }[]): Buffer {
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Not a JPEG');
    let offset = 2;
    if (jpeg[2] === 0xff && jpeg[3] === 0xe0) offset = 4 + jpeg.readUInt16BE(4);
    return Buffer.concat([jpeg.subarray(0, offset), ...segments.map(({ marker, payload }) => segment(marker, payload)), jpeg.subarray(offset)]);
}

/** Every private value the leaky fixture carries. None of them may be stored or served. */
export const PRIVATE_VALUES = {
    bodySerial: 'BODY-SERIAL-90210',
    lensSerial: 'LENS-SERIAL-55501',
    cameraSerial: 'CAMERA-SERIAL-77003',
    ownerName: 'Pat Owner-Name',
    makerNote: 'MAKERNOTE-PRIVATE-BLOB',
    userComment: 'USERCOMMENT-PRIVATE-NOTE',
    software: 'PrivateEditor 9.1',
    hostComputer: 'owners-laptop.local',
    imageUniqueId: 'IMAGE-UNIQUE-ID-0F0F',
    xmpCreator: 'Xmp Creator Name',
    xmpSecret: 'xmp-private-value',
    iptcByline: 'Iptc Byline Name',
} as const;

/** The public and curator-only values the leaky fixture carries. */
export const KEPT_VALUES = {
    make: 'Fixture Camera Co',
    model: 'FX-1',
    lensModel: 'FX 35mm F1.8',
    artist: 'Pat Artist',
    copyright: 'Copyright Pat Artist',
} as const;

/**
 * A decodable JPEG whose metadata includes GPS, serial numbers, an owner
 * name, MakerNote, UserComment, Software, HostComputer, ImageUniqueID, an
 * embedded thumbnail, XMP, and IPTC, alongside the allowlisted technical
 * fields, Artist, and Copyright.
 */
export async function leakyJpeg(): Promise<{ jpeg: Buffer; thumbnail: Buffer }> {
    const base = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg({ quality: 90 }).toBuffer();
    const thumbnail = await sharp({ create: { width: 16, height: 12, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg({ quality: 50 }).toBuffer();
    const ascii = (value: string): TiffValue => ({ type: 'ascii', value });
    const exif = buildExif({
        ifd0: {
            0x010f: ascii(KEPT_VALUES.make),
            0x0110: ascii(KEPT_VALUES.model),
            0x0131: ascii(PRIVATE_VALUES.software),
            0x0132: ascii('2024:05:02 09:00:00'),
            0x013b: ascii(KEPT_VALUES.artist),
            0x013c: ascii(PRIVATE_VALUES.hostComputer),
            0x8298: ascii(KEPT_VALUES.copyright),
            0xc62f: ascii(PRIVATE_VALUES.cameraSerial),
        },
        exif: {
            0x829a: { type: 'rational', value: [[1, 200]] },
            0x829d: { type: 'rational', value: [[18, 10]] },
            0x8827: { type: 'short', value: [400] },
            0x9003: ascii('2024:05:01 14:30:00'),
            0x9011: ascii('-07:00'),
            0x920a: { type: 'rational', value: [[35, 1]] },
            0x927c: { type: 'undefined', value: Buffer.from(PRIVATE_VALUES.makerNote, 'latin1') },
            0x9286: { type: 'undefined', value: Buffer.concat([Buffer.from('ASCII\0\0\0', 'latin1'), Buffer.from(PRIVATE_VALUES.userComment, 'latin1')]) },
            0xa420: ascii(PRIVATE_VALUES.imageUniqueId),
            0xa430: ascii(PRIVATE_VALUES.ownerName),
            0xa431: ascii(PRIVATE_VALUES.bodySerial),
            0xa434: ascii(KEPT_VALUES.lensModel),
            0xa435: ascii(PRIVATE_VALUES.lensSerial),
        },
        gps: {
            0x0000: { type: 'byte', value: [2, 3, 0, 0] },
            0x0001: ascii('N'),
            0x0002: { type: 'rational', value: [[37, 1], [46, 1], [2964, 100]] },
            0x0003: ascii('W'),
            0x0004: { type: 'rational', value: [[122, 1], [25, 1], [984, 100]] },
            0x0005: { type: 'byte', value: [0] },
            0x0006: { type: 'rational', value: [[1250, 100]] },
        },
        thumbnail,
    });
    const jpeg = withSegments(base, [
        { marker: 0xe1, payload: exif },
        { marker: 0xe1, payload: xmpPayload({ 'dc:creator': PRIVATE_VALUES.xmpCreator, 'fx:secret': PRIVATE_VALUES.xmpSecret }) },
        { marker: 0xed, payload: iptcPayload(PRIVATE_VALUES.iptcByline) },
    ]);
    return { jpeg, thumbnail };
}
