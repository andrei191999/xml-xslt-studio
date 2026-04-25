import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_FILE_TYPE_SYMLINK = 0o120000;
const WINDOWS_RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024; // 200 MB total
const MAX_ENTRY_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB per file
const MAX_ENTRY_NAME_LENGTH = 260; // Windows PATH_MAX

type ZipEntryMetadata = {
    compressionMethod: number;
    compressedSize: number;
    crc32: number;
    fileName: string;
    generalPurposeFlags: number;
    uncompressedSize: number;
};

interface ZipCentralDirectoryEntry extends ZipEntryMetadata {
    externalAttributes: number;
    localHeaderOffset: number;
}

interface ZipLocalFileHeader extends ZipEntryMetadata {
    dataOffset: number;
}

interface ZipEntry extends ZipEntryMetadata {
    dataOffset: number;
    externalAttributes: number;
    localHeaderOffset: number;
}

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
    const table = new Uint32Array(256);
    for (let value = 0; value < 256; value += 1) {
        let crc = value;
        for (let round = 0; round < 8; round += 1) {
            crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
        }
        table[value] = crc >>> 0;
    }
    return table;
}

function crc32(buffer: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function ensureRange(buffer: Buffer, offset: number, length: number, context: string): void {
    if (offset < 0 || length < 0 || offset + length > buffer.length) {
        throw new Error(`PHIVE bundle ZIP ${context} is truncated.`);
    }
}

function readUtf8String(buffer: Buffer, offset: number, length: number, context: string): string {
    ensureRange(buffer, offset, length, context);
    return buffer.slice(offset, offset + length).toString('utf8');
}

function findEndOfCentralDirectory(buffer: Buffer): number {
    const minOffset = Math.max(0, buffer.length - 22 - 0xffff);
    for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
        if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
            return offset;
        }
    }
    throw new Error('PHIVE bundle ZIP is missing the end-of-central-directory record.');
}

function readCentralDirectory(buffer: Buffer): ZipCentralDirectoryEntry[] {
    const eocdOffset = findEndOfCentralDirectory(buffer);
    const entryCount = buffer.readUInt16LE(eocdOffset + 10);
    const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
    const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
    ensureRange(buffer, centralDirectoryOffset, centralDirectorySize, 'central directory');

    const entries: ZipCentralDirectoryEntry[] = [];
    let offset = centralDirectoryOffset;

    for (let index = 0; index < entryCount; index += 1) {
        ensureRange(buffer, offset, 46, 'central directory entry');
        if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
            throw new Error('PHIVE bundle ZIP central directory is malformed.');
        }

        const generalPurposeFlags = buffer.readUInt16LE(offset + 8);
        const compressionMethod = buffer.readUInt16LE(offset + 10);
        const crc32Value = buffer.readUInt32LE(offset + 16);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const uncompressedSize = buffer.readUInt32LE(offset + 24);
        const fileNameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const externalAttributes = buffer.readUInt32LE(offset + 38);
        const localHeaderOffset = buffer.readUInt32LE(offset + 42);
        const entrySize = 46 + fileNameLength + extraLength + commentLength;
        ensureRange(buffer, offset, entrySize, 'central directory entry');
        const fileName = readUtf8String(
            buffer,
            offset + 46,
            fileNameLength,
            'central directory entry filename',
        );

        entries.push({
            compressionMethod,
            compressedSize,
            crc32: crc32Value,
            externalAttributes,
            fileName,
            generalPurposeFlags,
            localHeaderOffset,
            uncompressedSize,
        });
        offset += entrySize;
    }

    return entries;
}

function readLocalFileHeader(buffer: Buffer, entry: ZipCentralDirectoryEntry): ZipLocalFileHeader {
    ensureRange(buffer, entry.localHeaderOffset, 30, `local header for ${entry.fileName}`);
    if (buffer.readUInt32LE(entry.localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
        throw new Error(`PHIVE bundle ZIP entry ${entry.fileName} has an invalid local header.`);
    }

    const generalPurposeFlags = buffer.readUInt16LE(entry.localHeaderOffset + 6);
    const compressionMethod = buffer.readUInt16LE(entry.localHeaderOffset + 8);
    const crc32Value = buffer.readUInt32LE(entry.localHeaderOffset + 14);
    const compressedSize = buffer.readUInt32LE(entry.localHeaderOffset + 18);
    const uncompressedSize = buffer.readUInt32LE(entry.localHeaderOffset + 22);
    const fileNameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
    const extraFieldLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
    const fileName = readUtf8String(
        buffer,
        entry.localHeaderOffset + 30,
        fileNameLength,
        `local header filename for ${entry.fileName}`,
    );
    const dataOffset = entry.localHeaderOffset + 30 + fileNameLength + extraFieldLength;
    ensureRange(buffer, dataOffset, compressedSize, `payload for ${entry.fileName}`);

    return {
        compressionMethod,
        compressedSize,
        crc32: crc32Value,
        dataOffset,
        fileName,
        generalPurposeFlags,
        uncompressedSize,
    };
}

function assertMatchingHeaderField<T extends keyof ZipEntryMetadata>(
    central: ZipCentralDirectoryEntry,
    local: ZipLocalFileHeader,
    field: T,
    label: string,
): void {
    if (central[field] !== (local[field] as unknown as ZipCentralDirectoryEntry[T])) {
        throw new Error(
            `PHIVE bundle ZIP entry ${central.fileName} has mismatched ${label} between the central directory and local header.`,
        );
    }
}

function readValidatedEntries(buffer: Buffer): ZipEntry[] {
    return readCentralDirectory(buffer).map((central) => {
        const local = readLocalFileHeader(buffer, central);
        assertMatchingHeaderField(central, local, 'fileName', 'filename');
        assertMatchingHeaderField(central, local, 'compressionMethod', 'compression method');
        assertMatchingHeaderField(central, local, 'generalPurposeFlags', 'flags');
        assertMatchingHeaderField(central, local, 'crc32', 'CRC-32');
        assertMatchingHeaderField(central, local, 'compressedSize', 'compressed size');
        assertMatchingHeaderField(central, local, 'uncompressedSize', 'uncompressed size');

        if ((central.generalPurposeFlags & 0x08) !== 0) {
            throw new Error(`PHIVE bundle ZIP entry ${central.fileName} uses unsupported data descriptors.`);
        }

        return {
            ...central,
            dataOffset: local.dataOffset,
        };
    });
}

function isSymlink(entry: Pick<ZipEntry, 'externalAttributes'>): boolean {
    const unixMode = (entry.externalAttributes >>> 16) & 0xffff;
    return (unixMode & UNIX_FILE_TYPE_MASK) === UNIX_FILE_TYPE_SYMLINK;
}

function validateWindowsPathSegment(segment: string, fileName: string): void {
    if (segment.includes(':')) {
        throw new Error(`PHIVE bundle ZIP entry uses an unsupported Windows ":" path segment: ${fileName}`);
    }

    const trimmed = segment.replace(/[. ]+$/g, '');
    const baseName = trimmed.split('.')[0] ?? '';
    if (baseName && WINDOWS_RESERVED_BASENAME.test(baseName)) {
        throw new Error(`PHIVE bundle ZIP entry uses a reserved Windows device name: ${fileName}`);
    }
}

function resolveEntryPath(destinationDir: string, fileName: string): string {
    const normalized = fileName.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
        throw new Error(`PHIVE bundle ZIP contains an absolute path entry: ${fileName}`);
    }

    const segments = normalized.split('/').filter(Boolean);
    if (segments.some((segment) => segment === '..')) {
        throw new Error(`PHIVE bundle ZIP contains a parent-directory traversal entry: ${fileName}`);
    }
    for (const segment of segments) {
        validateWindowsPathSegment(segment, fileName);
    }

    const resolvedPath = path.resolve(destinationDir, ...segments);
    const relativePath = path.relative(destinationDir, resolvedPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error(`PHIVE bundle ZIP entry escapes the staging directory: ${fileName}`);
    }
    return resolvedPath;
}

function inflateEntryData(entry: ZipEntry, compressedData: Buffer): Buffer {
    if (entry.compressionMethod === 0) {
        return compressedData;
    }
    if (entry.compressionMethod === 8) {
        try {
            return zlib.inflateRawSync(compressedData, {
                maxOutputLength: MAX_ENTRY_UNCOMPRESSED_BYTES + 1,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/maxOutputLength|output length|buffer larger than|ERR_BUFFER_TOO_LARGE/i.test(message)) {
                throw new Error(
                    `PHIVE bundle ZIP entry ${entry.fileName} exceeds the ${MAX_ENTRY_UNCOMPRESSED_BYTES} byte extraction limit.`,
                );
            }
            throw new Error(`PHIVE bundle ZIP entry ${entry.fileName} could not be inflated: ${message}`);
        }
    }
    throw new Error(`PHIVE bundle ZIP uses unsupported compression method ${entry.compressionMethod}.`);
}

export function extractZipToDirectory(zipFilePath: string, destinationDir: string): void {
    const buffer = fs.readFileSync(zipFilePath);
    const entries = readValidatedEntries(buffer);

    for (const entry of entries) {
        if (entry.fileName.length > MAX_ENTRY_NAME_LENGTH) {
            throw new Error(
                `PHIVE bundle ZIP entry name exceeds ${MAX_ENTRY_NAME_LENGTH} characters: ${entry.fileName.slice(0, 80)}...`,
            );
        }
    }

    let totalUncompressed = 0;
    for (const entry of entries) {
        if (entry.uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
            throw new Error(
                `PHIVE bundle ZIP entry ${entry.fileName} uncompressed size (${entry.uncompressedSize} bytes) exceeds the ${MAX_ENTRY_UNCOMPRESSED_BYTES} byte limit.`,
            );
        }
        totalUncompressed += entry.uncompressedSize;
    }
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
        throw new Error(
            `PHIVE bundle ZIP total uncompressed size (${totalUncompressed} bytes) exceeds the ${MAX_UNCOMPRESSED_BYTES} byte limit.`,
        );
    }

    fs.mkdirSync(destinationDir, { recursive: true });

    try {
        let extractedBytes = 0;
        for (const entry of entries) {
            if (isSymlink(entry)) {
                throw new Error(`PHIVE bundle ZIP contains an unsupported symlink entry: ${entry.fileName}`);
            }

            const entryPath = resolveEntryPath(destinationDir, entry.fileName);
            if (entry.fileName.endsWith('/')) {
                fs.mkdirSync(entryPath, { recursive: true });
                continue;
            }

            const inflated = inflateEntryData(
                entry,
                buffer.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize),
            );
            if (inflated.length > MAX_ENTRY_UNCOMPRESSED_BYTES) {
                throw new Error(
                    `PHIVE bundle ZIP entry ${entry.fileName} exceeds the ${MAX_ENTRY_UNCOMPRESSED_BYTES} byte extraction limit.`,
                );
            }
            if (inflated.length !== entry.uncompressedSize) {
                throw new Error(`PHIVE bundle ZIP entry ${entry.fileName} has an unexpected extracted size.`);
            }

            extractedBytes += inflated.length;
            if (extractedBytes > MAX_UNCOMPRESSED_BYTES) {
                throw new Error(
                    `PHIVE bundle ZIP extracted total (${extractedBytes} bytes) exceeds the ${MAX_UNCOMPRESSED_BYTES} byte limit.`,
                );
            }
            if (crc32(inflated) !== entry.crc32) {
                throw new Error(`PHIVE bundle ZIP entry ${entry.fileName} failed CRC-32 validation.`);
            }

            fs.mkdirSync(path.dirname(entryPath), { recursive: true });
            fs.writeFileSync(entryPath, inflated);
        }
    } catch (error) {
        fs.rmSync(destinationDir, { recursive: true, force: true });
        throw error;
    }
}
