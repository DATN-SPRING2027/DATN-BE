import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  ChatObjectStorage,
  StoredObjectMetadata,
} from './chat-object-storage';

const PROD_VAULT_MOUNT_DIR = '/var/lib/continuum/vault';

function resolveDefaultVaultRoot(): string {
  if (existsSync(PROD_VAULT_MOUNT_DIR)) {
    return resolve(PROD_VAULT_MOUNT_DIR);
  }
  return resolve(process.cwd(), '..', '.data', 'continuum-vault');
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
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
    // Hardcoded enterprise policy: always store in the dedicated Local Enterprise Vault
    // across both LOCAL and PROD environments without requiring .env overrides.
    this.forceLocal = true;
    this.localDisabled =
      String(config.get<string>('LOCAL_STORAGE_DISABLED') ?? '')
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
    const bytes = await streamToBuffer(body);
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
    );
  }

  async createDownloadUrl(
    key: string,
    expiresInSeconds = 900,
    response?: {
      contentType: string;
      contentDisposition: 'inline' | 'attachment';
      filename: string;
    },
  ): Promise<string> {
    if (!this.useLocal()) {
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

    const path = this.localPath(key);
    const bytes = await readFile(path);
    const meta = await this.headObject(key);
    const mime =
      response?.contentType || meta.contentType || 'application/octet-stream';
    return `data:${mime};base64,${bytes.toString('base64')}`;
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
