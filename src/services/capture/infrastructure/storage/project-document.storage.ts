import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { R2Storage } from './r2.storage';

export interface StoredDocumentPrefixInspection {
  size: number;
  contentType?: string;
  prefix: Buffer;
}

@Injectable()
export class ProjectDocumentStorage {
  private readonly localRoot: string;

  constructor(
    private readonly r2: R2Storage,
    config: ConfigService,
  ) {
    this.localRoot = resolve(
      config.get<string>('WORK_NOTE_LOCAL_STORAGE_DIR') ||
        join(tmpdir(), 'continuum-work-notes'),
    );
  }

  validateKey(key: string): void {
    if (
      !/^work-notes\/[a-f\d]{24}\/[a-f\d]{24}\/[a-f\d]{24}\/[0-9a-f-]{36}$/i.test(
        key,
      )
    ) {
      throw new Error('Invalid document storage key');
    }
  }

  private localPath(key: string): string {
    this.validateKey(key);
    const path = resolve(this.localRoot, key);
    if (!path.startsWith(this.localRoot + sep))
      throw new Error('Invalid document storage key');
    return path;
  }

  isDirectCloudEnabled(): boolean {
    return this.r2.isConfigured();
  }

  private useLocal(): boolean {
    if (this.r2.isConfigured()) return false;
    if (process.env.NODE_ENV === 'production')
      throw new ServiceUnavailableException({
        code: 'DOCUMENT_STORAGE_UNAVAILABLE',
        message: 'Project Document storage is unavailable.',
      });
    return true;
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    this.validateKey(key);
    if (!this.useLocal()) return this.r2.putObject(key, bytes, contentType);
    const path = this.localPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' });
  }

  async get(key: string): Promise<Buffer> {
    this.validateKey(key);
    if (!this.useLocal()) return this.r2.getObject(key);
    return readFile(this.localPath(key));
  }

  async delete(key: string): Promise<void> {
    this.validateKey(key);
    if (!this.useLocal()) return this.r2.deleteObject(key);
    await rm(this.localPath(key), { force: true });
  }

  async createDirectUploadUrl(
    key: string,
    contentType: string,
    expiresInSeconds = 900,
  ): Promise<string> {
    this.validateKey(key);
    if (!this.isDirectCloudEnabled()) {
      throw new ServiceUnavailableException({
        code: 'DOCUMENT_DIRECT_UPLOAD_UNAVAILABLE',
        message: 'Direct cloud object upload is not configured.',
      });
    }
    return this.r2.createUploadUrl(key, contentType, expiresInSeconds);
  }

  async createDirectDownloadUrl(
    key: string,
    expiresInSeconds = 120,
    options?: {
      fileName?: string;
      contentType?: string;
      disposition?: 'attachment' | 'inline';
    },
  ): Promise<string> {
    this.validateKey(key);
    if (!this.isDirectCloudEnabled()) {
      throw new ServiceUnavailableException({
        code: 'DOCUMENT_DIRECT_DOWNLOAD_UNAVAILABLE',
        message: 'Direct cloud object download is not configured.',
      });
    }
    const disposition = options?.disposition ?? 'attachment';
    const responseContentDisposition = options?.fileName
      ? `${disposition}; filename*=UTF-8''${encodeURIComponent(options.fileName)}`
      : undefined;
    return this.r2.createDownloadUrl(key, expiresInSeconds, {
      ...(responseContentDisposition ? { responseContentDisposition } : {}),
      ...(options?.contentType
        ? { responseContentType: options.contentType }
        : {}),
    });
  }

  async inspectStoredPrefix(
    key: string,
    maxBytes = 64,
  ): Promise<StoredDocumentPrefixInspection> {
    this.validateKey(key);
    const clampedMax = Math.max(1, Math.min(8192, Math.trunc(maxBytes)));
    if (!this.useLocal()) {
      const inspected = await this.r2.inspectObjectPrefix(key, clampedMax);
      return {
        size: inspected.contentLength,
        ...(inspected.contentType
          ? { contentType: inspected.contentType }
          : {}),
        prefix: inspected.prefix,
      };
    }
    const path = this.localPath(key);
    const info = await stat(path);
    const bytesToRead = Math.min(info.size, clampedMax);
    if (bytesToRead <= 0) {
      return { size: 0, prefix: Buffer.alloc(0) };
    }
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
      return {
        size: info.size,
        prefix: buffer.subarray(0, bytesRead),
      };
    } finally {
      await handle.close();
    }
  }
}
