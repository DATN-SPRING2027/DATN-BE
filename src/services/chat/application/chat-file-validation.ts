const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const GIF87A_MAGIC = Buffer.from('GIF87a', 'ascii');
const GIF89A_MAGIC = Buffer.from('GIF89a', 'ascii');
const RIFF_MAGIC = Buffer.from('RIFF', 'ascii');
const WEBP_MAGIC = Buffer.from('WEBP', 'ascii');
const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
const ZIP_LOCAL_HEADER_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIR_SIGNATURE = 0x02014b50;

const OOXML_REQUIRED_PREFIX: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'word/',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xl/',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'ppt/',
};

const ACTIVE_CONTENT_PATTERNS = [
  /<!doctype\s+html\b/i,
  /<html[\s>]/i,
  /<svg[\s>]/i,
  /<script[\s>]/i,
  /<iframe[\s>]/i,
  /<object[\s>]/i,
  /<embed[\s>]/i,
  /<!entity\b/i,
  /\bjavascript\s*:/i,
  /\bon(?:load|error|click|mouseover|focus)\s*=/i,
];

const MAX_ZIP_ENTRIES = 2000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_COMPRESSION_RATIO = 100;
const MAX_ZIP_TAIL_BYTES = 512 * 1024;
const MAX_TEXT_SCAN_BYTES = 16 * 1024;

export interface ChatFileValidationResult {
  valid: boolean;
  reason?: string;
}

export function isOoxmlContentType(contentType: string): boolean {
  return contentType in OOXML_REQUIRED_PREFIX;
}

export function validateLeadingMagicBytes(
  contentType: string,
  header: Buffer,
): ChatFileValidationResult {
  const normalized = contentType.toLowerCase().trim();
  if (header.length === 0) {
    return { valid: false, reason: 'Uploaded file is empty.' };
  }

  switch (normalized) {
    case 'image/png':
      return header.length >= PNG_MAGIC.length &&
        header.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)
        ? { valid: true }
        : { valid: false, reason: 'File does not match PNG signature.' };
    case 'image/jpeg':
      return header.length >= JPEG_MAGIC.length &&
        header.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)
        ? { valid: true }
        : { valid: false, reason: 'File does not match JPEG signature.' };
    case 'image/gif':
      return header.length >= GIF87A_MAGIC.length &&
        (header.subarray(0, GIF87A_MAGIC.length).equals(GIF87A_MAGIC) ||
          header.subarray(0, GIF89A_MAGIC.length).equals(GIF89A_MAGIC))
        ? { valid: true }
        : { valid: false, reason: 'File does not match GIF signature.' };
    case 'image/webp':
      return header.length >= 12 &&
        header.subarray(0, 4).equals(RIFF_MAGIC) &&
        header.subarray(8, 12).equals(WEBP_MAGIC)
        ? { valid: true }
        : { valid: false, reason: 'File does not match WebP signature.' };
    case 'application/pdf':
      return header.length >= PDF_MAGIC.length &&
        header.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)
        ? { valid: true }
        : { valid: false, reason: 'File does not match PDF signature.' };
    case 'text/plain':
    case 'text/csv':
      return validatePlainTextChunk(header);
    default:
      if (isOoxmlContentType(normalized)) {
        return header.length >= ZIP_LOCAL_HEADER_MAGIC.length &&
          header
            .subarray(0, ZIP_LOCAL_HEADER_MAGIC.length)
            .equals(ZIP_LOCAL_HEADER_MAGIC)
          ? { valid: true }
          : {
              valid: false,
              reason: 'File does not match OOXML ZIP signature.',
            };
      }
      return { valid: false, reason: 'Unsupported content type.' };
  }
}

export function validatePlainTextChunk(
  chunk: Buffer,
): ChatFileValidationResult {
  if (chunk.includes(0x00)) {
    return {
      valid: false,
      reason: 'Binary content is not allowed for text uploads.',
    };
  }
  const text = chunk.toString('utf8');
  for (const pattern of ACTIVE_CONTENT_PATTERNS) {
    if (pattern.test(text)) {
      return {
        valid: false,
        reason: 'Active HTML/SVG/script content is not allowed.',
      };
    }
  }
  return { valid: true };
}

export function validateOoxmlZipStructure(
  contentType: string,
  tailBuffer: Buffer,
  totalFileSize: number,
): ChatFileValidationResult {
  const normalized = contentType.toLowerCase().trim();
  const requiredPrefix = OOXML_REQUIRED_PREFIX[normalized];
  if (!requiredPrefix) {
    return { valid: false, reason: 'Unsupported OOXML content type.' };
  }
  if (tailBuffer.length < 22) {
    return { valid: false, reason: 'Invalid ZIP archive structure.' };
  }

  const maxSearchStart = Math.max(0, tailBuffer.length - 65_557);
  let eocdOffset = -1;
  for (
    let offset = tailBuffer.length - 22;
    offset >= maxSearchStart;
    offset--
  ) {
    if (tailBuffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
      const commentLen = tailBuffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLen === tailBuffer.length) {
        eocdOffset = offset;
        break;
      }
    }
  }
  if (eocdOffset < 0) {
    return { valid: false, reason: 'Missing ZIP End-of-Central-Directory.' };
  }

  const totalEntries = tailBuffer.readUInt16LE(eocdOffset + 10);
  const cdSize = tailBuffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = tailBuffer.readUInt32LE(eocdOffset + 16);

  if (
    totalEntries === 0 ||
    totalEntries === 0xffff ||
    totalEntries > MAX_ZIP_ENTRIES
  ) {
    return {
      valid: false,
      reason: 'ZIP archive entry count exceeds safe limits.',
    };
  }
  if (
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff ||
    cdSize > MAX_ZIP_TAIL_BYTES
  ) {
    return {
      valid: false,
      reason: 'ZIP central directory exceeds safe limits.',
    };
  }

  const tailWindowStart = totalFileSize - tailBuffer.length;
  const localCdOffset = cdOffset - tailWindowStart;
  if (localCdOffset < 0 || localCdOffset + cdSize > eocdOffset) {
    return {
      valid: false,
      reason: 'ZIP central directory bounds are invalid.',
    };
  }

  let cursor = localCdOffset;
  const cdEnd = localCdOffset + cdSize;
  let parsedEntries = 0;
  let totalUncompressed = 0;
  let hasContentTypes = false;
  let hasRequiredFolder = false;

  while (cursor + 46 <= cdEnd) {
    if (tailBuffer.readUInt32LE(cursor) !== ZIP_CENTRAL_DIR_SIGNATURE) {
      return {
        valid: false,
        reason: 'Corrupt ZIP central directory entry.',
      };
    }
    const compressedSize = tailBuffer.readUInt32LE(cursor + 20);
    const uncompressedSize = tailBuffer.readUInt32LE(cursor + 24);
    const fileNameLen = tailBuffer.readUInt16LE(cursor + 28);
    const extraLen = tailBuffer.readUInt16LE(cursor + 30);
    const commentLen = tailBuffer.readUInt16LE(cursor + 32);

    const nextCursor = cursor + 46 + fileNameLen + extraLen + commentLen;
    if (nextCursor > cdEnd) {
      return { valid: false, reason: 'Truncated ZIP central directory entry.' };
    }

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      uncompressedSize > MAX_ZIP_UNCOMPRESSED_BYTES
    ) {
      return { valid: false, reason: 'ZIP archive entry size is unsafe.' };
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
      return {
        valid: false,
        reason: 'ZIP archive uncompressed size exceeds limit.',
      };
    }

    if (
      uncompressedSize > 1024 * 1024 &&
      uncompressedSize / Math.max(1, compressedSize) > MAX_ZIP_COMPRESSION_RATIO
    ) {
      return {
        valid: false,
        reason: 'ZIP archive compression ratio exceeds safe limit.',
      };
    }

    const entryName = tailBuffer
      .subarray(cursor + 46, cursor + 46 + fileNameLen)
      .toString('utf8');
    if (
      entryName.includes('..') ||
      entryName.startsWith('/') ||
      entryName.startsWith('\\')
    ) {
      return {
        valid: false,
        reason: 'ZIP archive contains unsafe entry path.',
      };
    }

    if (entryName === '[Content_Types].xml') {
      hasContentTypes = true;
    }
    if (entryName.startsWith(requiredPrefix)) {
      hasRequiredFolder = true;
    }

    parsedEntries += 1;
    if (parsedEntries > MAX_ZIP_ENTRIES) {
      return {
        valid: false,
        reason: 'ZIP archive entry count exceeds safe limits.',
      };
    }
    cursor = nextCursor;
  }

  if (parsedEntries !== totalEntries) {
    return {
      valid: false,
      reason: 'ZIP central directory entry count mismatch.',
    };
  }

  if (
    totalUncompressed > 1024 * 1024 &&
    totalUncompressed / Math.max(1, totalFileSize) > MAX_ZIP_COMPRESSION_RATIO
  ) {
    return {
      valid: false,
      reason: 'ZIP archive overall compression ratio exceeds safe limit.',
    };
  }

  if (!hasContentTypes || !hasRequiredFolder) {
    return {
      valid: false,
      reason: 'ZIP archive is not a valid OOXML document.',
    };
  }

  return { valid: true };
}

export class ChatUploadInspector {
  private readonly normalizedType: string;
  private readonly isZip: boolean;
  private readonly isText: boolean;
  private readonly headerChunks: Buffer[] = [];
  private headerBytes = 0;
  private headerValidated = false;
  private tailBuffer: Buffer = Buffer.alloc(0);
  private totalBytes = 0;

  constructor(contentType: string) {
    this.normalizedType = contentType.toLowerCase().trim();
    this.isZip = isOoxmlContentType(this.normalizedType);
    this.isText =
      this.normalizedType === 'text/plain' ||
      this.normalizedType === 'text/csv';
  }

  push(chunk: Buffer): ChatFileValidationResult {
    this.totalBytes += chunk.length;

    const headerLimit = this.isText ? MAX_TEXT_SCAN_BYTES : 64;
    if (this.headerBytes < headerLimit) {
      const needed = headerLimit - this.headerBytes;
      const slice = chunk.length <= needed ? chunk : chunk.subarray(0, needed);
      this.headerChunks.push(Buffer.from(slice));
      this.headerBytes += slice.length;
    }

    if (this.isText) {
      const textCheck = validatePlainTextChunk(chunk);
      if (!textCheck.valid) return textCheck;
    }

    if (!this.headerValidated && this.headerBytes >= this.minHeaderBytes()) {
      const header = Buffer.concat(this.headerChunks);
      const check = validateLeadingMagicBytes(this.normalizedType, header);
      if (!check.valid) return check;
      this.headerValidated = true;
    }

    if (this.isZip) {
      const combined =
        this.tailBuffer.length === 0
          ? Buffer.from(chunk)
          : Buffer.concat([this.tailBuffer, chunk]);
      this.tailBuffer =
        combined.length > MAX_ZIP_TAIL_BYTES
          ? combined.subarray(combined.length - MAX_ZIP_TAIL_BYTES)
          : combined;
    }

    return { valid: true };
  }

  finish(): ChatFileValidationResult {
    const header = Buffer.concat(this.headerChunks);
    const leadingCheck = validateLeadingMagicBytes(this.normalizedType, header);
    if (!leadingCheck.valid) return leadingCheck;

    if (this.isZip) {
      return validateOoxmlZipStructure(
        this.normalizedType,
        this.tailBuffer,
        this.totalBytes,
      );
    }

    return { valid: true };
  }

  private minHeaderBytes(): number {
    switch (this.normalizedType) {
      case 'image/png':
        return 8;
      case 'image/jpeg':
        return 3;
      case 'image/gif':
        return 6;
      case 'image/webp':
        return 12;
      case 'application/pdf':
        return 5;
      case 'text/plain':
      case 'text/csv':
        return 1;
      default:
        return 4;
    }
  }
}
