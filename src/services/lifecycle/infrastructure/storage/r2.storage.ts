import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';

const MAX_SIGNED_URL_TTL_SECONDS = 3600;

@Injectable()
export class R2Storage {
  private readonly endpoint?: string;
  private readonly accessKeyId?: string;
  private readonly secretAccessKey?: string;
  private readonly bucket?: string;
  private cachedClient?: S3Client;

  constructor(config: ConfigService) {
    this.endpoint = config.get<string>('R2_ENDPOINT');
    this.accessKeyId = config.get<string>('R2_ACCESS_KEY_ID');
    this.secretAccessKey = config.get<string>('R2_SECRET_ACCESS_KEY');
    this.bucket = config.get<string>('R2_BUCKET');
  }

  createUploadUrl(
    key: string,
    contentType: string,
    expiresInSeconds = 900,
  ): Promise<string> {
    const safeKey = this.validateKey(key);
    return getSignedUrl(
      this.client(),
      new PutObjectCommand({
        Bucket: this.bucketName(),
        Key: safeKey,
        ContentType: contentType,
      }),
      { expiresIn: this.clampTtl(expiresInSeconds) },
    );
  }

  createDownloadUrl(key: string, expiresInSeconds = 900): Promise<string> {
    const safeKey = this.validateKey(key);
    return getSignedUrl(
      this.client(),
      new GetObjectCommand({
        Bucket: this.bucketName(),
        Key: safeKey,
        ResponseContentDisposition: 'attachment',
      }),
      { expiresIn: this.clampTtl(expiresInSeconds) },
    );
  }

  private validateKey(key: string): string {
    const normalized = key.trim();
    const hasControlChar = Array.from(normalized).some((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    });
    if (
      !normalized ||
      normalized.startsWith('/') ||
      normalized.includes('\\') ||
      hasControlChar ||
      normalized.split('/').some((seg) => seg === '..' || seg === '.')
    ) {
      throw new Error('Invalid R2 object key');
    }
    return normalized;
  }

  private clampTtl(expiresInSeconds: number): number {
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      return 900;
    }
    return Math.min(Math.floor(expiresInSeconds), MAX_SIGNED_URL_TTL_SECONDS);
  }

  private client(): S3Client {
    if (this.cachedClient) {
      return this.cachedClient;
    }
    if (!this.endpoint || !this.accessKeyId || !this.secretAccessKey) {
      throw new Error('R2 storage is not configured');
    }

    this.cachedClient = new S3Client({
      region: 'auto',
      endpoint: this.endpoint,
      credentials: {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
      },
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 5_000,
        socketTimeout: 15_000,
      }),
    });
    return this.cachedClient;
  }

  private bucketName(): string {
    if (!this.bucket) {
      throw new Error('R2 bucket is not configured');
    }

    return this.bucket;
  }
}
