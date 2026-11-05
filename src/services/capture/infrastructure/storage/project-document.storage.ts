import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { R2Storage } from './r2.storage';

const PROD_VAULT_MOUNT_DIR = '/var/lib/continuum/vault';

function resolveDefaultVaultRoot(): string {
  if (existsSync(PROD_VAULT_MOUNT_DIR)) {
    return resolve(PROD_VAULT_MOUNT_DIR);
  }
  return resolve(process.cwd(), '..', '.data', 'continuum-vault');
}

export interface StoredDocumentPrefixInspection {
  size: number;
  contentType?: string;
  prefix: Buffer;
}

@Injectable()
export class ProjectDocumentStorage {
  private readonly localRoot: string;
  private readonly forceLocal: boolean;
  private readonly localDisabled: boolean;

  constructor(
    private readonly r2: R2Storage,
    config: ConfigService,
  ) {
    const configuredDir =
      config.get<string>('WORK_NOTE_LOCAL_STORAGE_DIR') ||
      config.get<string>('LOCAL_STORAGE_DIR');
    this.localRoot = resolve(configuredDir || resolveDefaultVaultRoot());
    // Hardcoded enterprise policy: always store in the dedicated Local Enterprise Vault
    // across both LOCAL and PROD environments without requiring .env overrides.
    this.forceLocal = true;
    this.localDisabled =
      String(config.get<string>('LOCAL_STORAGE_DISABLED') ?? '')
        .trim()
        .toLowerCase() === 'true';
  }

  getLocalRoot(): string {
    return this.localRoot;
  }

  validateKey(key: string): void {
    if (
      !/^(work-notes|work-reports)\/[a-f\d]{24}\/[a-f\d]{24}\/[a-f\d]{24}\/(?:[0-9a-f-]{36}|v\d+-[a-f\d]{12,64}\.md)$/i.test(
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
    if (this.forceLocal) return false;
    return this.r2.isConfigured();
  }

  private useLocal(): boolean {
    if (this.isDirectCloudEnabled()) return false;
    if (this.localDisabled)
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
    const existing = await stat(path).catch(() => null);
    if (existing) {
      const err = new Error(
        `EEXIST: file already exists, open '${path}'`,
      ) as Error & {
        code?: string;
      };
      err.code = 'EEXIST';
      throw err;
    }

    const stagingDir = join(this.localRoot, '.staging');
    await mkdir(stagingDir, { recursive: true });
    const stagingPath = join(stagingDir, `${randomUUID()}.part`);

    try {
      const handle = await open(stagingPath, 'wx');
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }

      await mkdir(dirname(path), { recursive: true });
      await rename(stagingPath, path);
    } catch (error) {
      await rm(stagingPath, { force: true }).catch(() => undefined);
      throw error;
    }

    await writeFile(
      `${path}.meta.json`,
      JSON.stringify({
        size: bytes.length,
        contentType,
        updatedAt: new Date().toISOString(),
      }),
      'utf-8',
    ).catch(() => undefined);
  }

  async get(key: string): Promise<Buffer> {
    this.validateKey(key);
    if (!this.useLocal()) return this.r2.getObject(key);
    const path = this.localPath(key);
    try {
      return await readFile(path);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (
        err?.code === 'ENOENT' &&
        this.r2.isConfigured() &&
        typeof this.r2.getObject === 'function'
      ) {
        try {
          const remoteBytes = await this.r2.getObject(key);
          await this.put(key, remoteBytes, 'application/octet-stream').catch(
            () => undefined,
          );
          return remoteBytes;
        } catch {
          throw error;
        }
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    this.validateKey(key);
    if (!this.useLocal()) return this.r2.deleteObject(key);
    const path = this.localPath(key);
    await rm(path, { force: true });
    await rm(`${path}.meta.json`, { force: true }).catch(() => undefined);
    await this.pruneEmptyParentDirs(dirname(path));
    if (this.r2.isConfigured() && typeof this.r2.deleteObject === 'function') {
      await this.r2.deleteObject(key).catch(() => undefined);
    }
  }

  private async pruneEmptyParentDirs(startDir: string): Promise<void> {
    const topBuckets = new Set([
      resolve(this.localRoot, 'work-notes'),
      resolve(this.localRoot, 'work-reports'),
      resolve(this.localRoot, '.staging'),
    ]);
    let current = resolve(startDir);
    while (
      current.startsWith(this.localRoot + sep) &&
      current !== this.localRoot &&
      !topBuckets.has(current)
    ) {
      try {
        const entries = await readdir(current);
        if (entries.length > 0) break;
        await rmdir(current);
        current = dirname(current);
      } catch {
        break;
      }
    }
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
    let info = await stat(path).catch(() => null);
    if (
      !info &&
      this.r2.isConfigured() &&
      typeof this.r2.getObject === 'function'
    ) {
      const migratedBytes = await this.r2.getObject(key).catch(() => null);
      if (migratedBytes) {
        await this.put(key, migratedBytes, 'application/octet-stream').catch(
          () => undefined,
        );
        info = await stat(path).catch(() => null);
      }
    }
    if (!info) {
      const err = new Error(
        `ENOENT: no such file or directory, stat '${path}'`,
      ) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    let contentType: string | undefined;
    try {
      const rawMeta = await readFile(`${path}.meta.json`, 'utf-8');
      const parsed = JSON.parse(rawMeta) as { contentType?: unknown };
      if (typeof parsed.contentType === 'string' && parsed.contentType.trim()) {
        contentType = parsed.contentType.trim();
      }
    } catch {
      // Optional sidecar metadata
    }
    const bytesToRead = Math.min(info.size, clampedMax);
    if (bytesToRead <= 0) {
      return {
        size: 0,
        ...(contentType ? { contentType } : {}),
        prefix: Buffer.alloc(0),
      };
    }
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
      return {
        size: info.size,
        ...(contentType ? { contentType } : {}),
        prefix: buffer.subarray(0, bytesRead),
      };
    } finally {
      await handle.close();
    }
  }
}
