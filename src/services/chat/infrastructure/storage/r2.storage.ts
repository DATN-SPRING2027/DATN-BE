import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type {
  ChatObjectStorage,
  StoredObjectMetadata,
  StoredObjectStream,
} from './chat-object-storage';

const PROD_VAULT_MOUNT_DIR = '/var/lib/continuum/vault';

function resolveDefaultVaultRoot(): string {
  if (existsSync(PROD_VAULT_MOUNT_DIR)) {
    return resolve(PROD_VAULT_MOUNT_DIR);
  }
  return resolve(process.cwd(), '..', '.data', 'continuum-vault');
}

function isForceLocalConfigured(config: ConfigService): boolean {
  const mode = String(
    config.get<string>('STORAGE_MODE') ??
      config.get<string>('CHAT_STORAGE_MODE') ??
      '',
  )
    .trim()
    .toLowerCase();
  const forceLocalEnv =
    String(config.get<string>('STORAGE_FORCE_LOCAL') ?? '')
      .trim()
      .toLowerCase() === 'true';
  return forceLocalEnv || mode === 'local';
}

@Injectable()
export class R2Storage implements ChatObjectStorage {
  private readonly endpoint?: string;
  private readonly accessKeyId?: string;
  private readonly secretAccessKey?: string;
  private readonly bucket?: string;
  private readonly localRoot: string;
  private readonly forceLocal: boolean;
  private readonly localDisabled: boolean;
  private readonly cloudFallbackEnabled: boolean;
  private clientInstance?: S3Client;

  constructor(config: ConfigService) {
    this.endpoint = config.get<string>('R2_ENDPOINT');
    this.accessKeyId = config.get<string>('R2_ACCESS_KEY_ID');
    this.secretAccessKey = config.get<string>('R2_SECRET_ACCESS_KEY');
    this.bucket = config.get<string>('R2_BUCKET');
    const configuredDir =
      config.get<string>('WORK_NOTE_LOCAL_STORAGE_DIR') ||
      config.get<string>('LOCAL_STORAGE_DIR');
    this.localRoot = resolve(configuredDir || resolveDefaultVaultRoot());
    this.forceLocal = isForceLocalConfigured(config);
    this.localDisabled =
      String(config.get<string>('LOCAL_STORAGE_DISABLED') ?? '')
        .trim()
        .toLowerCase() === 'true';
    this.cloudFallbackEnabled =
      String(config.get<string>('CHAT_STORAGE_CLOUD_FALLBACK_ENABLED') ?? '')
        .trim()
        .toLowerCase() === 'true';
  }

  isConfigured(): boolean {
    if (this.forceLocal) return false;
    return Boolean(
      this.endpoint && this.accessKeyId && this.secretAccessKey && this.bucket,
    );
  }

  private useLocal(): boolean {
    if (this.isConfigured()) return false;
    if (this.localDisabled) {
      throw new Error('R2 storage is not configured');
    }
    return true;
  }

  private localPath(key: string): string {
    const clean = key.replace(/^\/+/, '');
    if (!clean || clean.includes('..')) {
      throw new Error('Invalid chat object storage key');
    }
    const target = resolve(this.localRoot, clean);
    if (!target.startsWith(this.localRoot + sep)) {
      throw new Error('Invalid chat object storage key');
    }
    return target;
  }

  async putObject(
    key: string,
    body: Readable,
    contentType: string,
    size: number,
  ): Promise<void> {
    if (!this.useLocal()) {
      await this.client().send(
        new PutObjectCommand({
          Bucket: this.bucketName(),
          Key: key,
          Body: body,
          ContentLength: size,
          ContentType: contentType,
        }),
      );
      return;
    }

    const path = this.localPath(key);
    const stagingDir = join(this.localRoot, '.staging');
    await mkdir(stagingDir, { recursive: true });
    const stagingPath = join(stagingDir, `${randomUUID()}.part`);

    try {
      const output = createWriteStream(stagingPath, { flags: 'wx' });
      await pipeline(body, output);
      await mkdir(dirname(path), { recursive: true });
      await rename(stagingPath, path);
    } catch (error) {
      await rm(stagingPath, { force: true }).catch(() => undefined);
      throw error;
    }

    const info = await stat(path);
    await writeFile(
      `${path}.meta.json`,
      JSON.stringify({
        size: info.size,
        contentType,
        updatedAt: new Date().toISOString(),
      }),
      'utf-8',
    );
  }

  private hasCloudCredentials(): boolean {
    return Boolean(
      this.endpoint && this.accessKeyId && this.secretAccessKey && this.bucket,
    );
  }

  private async createCloudDownloadUrl(
    key: string,
    expiresInSeconds: number,
    response?: {
      contentType: string;
      contentDisposition: 'inline' | 'attachment';
      filename: string;
    },
  ): Promise<string> {
    return getSignedUrl(
      this.client(),
      new GetObjectCommand({
        Bucket: this.bucketName(),
        Key: key,
        ...(response
          ? {
              ResponseContentType: response.contentType,
              ResponseContentDisposition: `${response.contentDisposition}; filename*=UTF-8''${encodeURIComponent(response.filename)}`,
            }
          : {}),
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async createDownloadUrl(
    key: string,
    expiresInSeconds = 900,
    response?: {
      contentType: string;
      contentDisposition: 'inline' | 'attachment';
      filename: string;
      localStreamUrl?: string;
    },
  ): Promise<string> {
    if (!this.useLocal()) {
      return this.createCloudDownloadUrl(key, expiresInSeconds, response);
    }

    const path = this.localPath(key);
    try {
      await stat(path);
      if (response?.localStreamUrl) {
        return response.localStreamUrl;
      }
      throw new Error(
        'Local storage requires streaming download endpoint; inline Base64 data URIs are disabled',
      );
    } catch (localError) {
      const isMissingLocal =
        (localError as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
      if (
        !isMissingLocal ||
        !this.cloudFallbackEnabled ||
        !this.hasCloudCredentials()
      ) {
        throw localError;
      }
      try {
        await this.client().send(
          new HeadObjectCommand({ Bucket: this.bucketName(), Key: key }),
        );
        return await this.createCloudDownloadUrl(
          key,
          expiresInSeconds,
          response,
        );
      } catch (cloudError) {
        const statusCode = (
          cloudError as { $metadata?: { httpStatusCode?: number } } | undefined
        )?.$metadata?.httpStatusCode;
        const errName = (cloudError as { name?: string } | undefined)?.name;
        if (
          statusCode === 404 ||
          statusCode === 403 ||
          errName === 'NotFound' ||
          errName === 'NoSuchKey' ||
          errName === 'AccessDenied'
        ) {
          throw localError;
        }
        throw cloudError;
      }
    }
  }

  async openReadStream(key: string): Promise<StoredObjectStream> {
    if (!this.useLocal()) {
      const result = await this.client().send(
        new GetObjectCommand({ Bucket: this.bucketName(), Key: key }),
      );
      if (!result.Body) {
        throw new Error('R2 object body is unavailable');
      }
      return {
        stream: result.Body as Readable,
        size: result.ContentLength,
        contentType: result.ContentType,
      };
    }

    const path = this.localPath(key);
    try {
      const info = await stat(path);
      let contentType: string | undefined;
      try {
        const raw = await readFile(`${path}.meta.json`, 'utf-8');
        const parsed = JSON.parse(raw) as { contentType?: string };
        contentType = parsed.contentType;
      } catch {
        // Optional metadata file
      }
      return {
        stream: createReadStream(path),
        size: info.size,
        contentType,
      };
    } catch (localError) {
      const isMissingLocal =
        (localError as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
      if (
        !isMissingLocal ||
        !this.cloudFallbackEnabled ||
        !this.hasCloudCredentials()
      ) {
        throw localError;
      }
      const result = await this.client().send(
        new GetObjectCommand({ Bucket: this.bucketName(), Key: key }),
      );
      if (!result.Body) throw localError;
      return {
        stream: result.Body as Readable,
        size: result.ContentLength,
        contentType: result.ContentType,
      };
    }
  }

  async headObject(key: string): Promise<StoredObjectMetadata> {
    if (!this.useLocal()) {
      const result = await this.client().send(
        new HeadObjectCommand({ Bucket: this.bucketName(), Key: key }),
      );
      return { size: result.ContentLength, contentType: result.ContentType };
    }

    const path = this.localPath(key);
    const info = await stat(path);
    let contentType: string | undefined;
    try {
      const raw = await readFile(`${path}.meta.json`, 'utf-8');
      const parsed = JSON.parse(raw) as { contentType?: string };
      contentType = parsed.contentType;
    } catch {
      // Optional metadata file
    }
    return { size: info.size, contentType };
  }

  async deleteObject(key: string): Promise<void> {
    if (!this.useLocal()) {
      await this.client().send(
        new DeleteObjectCommand({ Bucket: this.bucketName(), Key: key }),
      );
      return;
    }

    const path = this.localPath(key);
    await rm(path, { force: true });
    await rm(`${path}.meta.json`, { force: true }).catch(() => undefined);
    if (this.cloudFallbackEnabled && this.hasCloudCredentials()) {
      await this.client()
        .send(new DeleteObjectCommand({ Bucket: this.bucketName(), Key: key }))
        .catch(() => undefined);
    }
  }

  private client(): S3Client {
    if (this.clientInstance) return this.clientInstance;
    if (!this.endpoint || !this.accessKeyId || !this.secretAccessKey) {
      throw new Error('R2 storage is not configured');
    }

    this.clientInstance = new S3Client({
      region: 'auto',
      endpoint: this.endpoint,
      credentials: {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
      },
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 5_000,
        socketTimeout: 30_000,
      }),
      maxAttempts: 3,
    });
    return this.clientInstance;
  }

  private bucketName(): string {
    if (!this.bucket) {
      throw new Error('R2 bucket is not configured');
    }

    return this.bucket;
  }
}
