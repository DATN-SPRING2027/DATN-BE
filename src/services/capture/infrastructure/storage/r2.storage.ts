import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface R2DownloadUrlOptions {
  responseContentDisposition?: string;
  responseContentType?: string;
}

export interface R2ObjectPrefixInspection {
  contentLength: number;
  contentType?: string;
  etag?: string;
  prefix: Buffer;
}

@Injectable()
export class R2Storage implements OnModuleDestroy {
  private readonly endpoint?: string;
  private readonly accessKeyId?: string;
  private readonly secretAccessKey?: string;
  private readonly bucket?: string;
  private s3Client?: S3Client;

  constructor(config: ConfigService) {
    this.endpoint = config.get<string>('R2_ENDPOINT')?.trim() || undefined;
    this.accessKeyId =
      config.get<string>('R2_ACCESS_KEY_ID')?.trim() || undefined;
    this.secretAccessKey =
      config.get<string>('R2_SECRET_ACCESS_KEY')?.trim() || undefined;
    this.bucket = config.get<string>('R2_BUCKET')?.trim() || undefined;
  }

  onModuleDestroy(): void {
    this.s3Client?.destroy();
    this.s3Client = undefined;
  }

  isConfigured(): boolean {
    return Boolean(
      this.endpoint && this.accessKeyId && this.secretAccessKey && this.bucket,
    );
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client().send(
      new PutObjectCommand({
        Bucket: this.bucketName(),
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: contentType,
      }),
    );
  }

  async getObject(key: string): Promise<Buffer> {
    const result = await this.client().send(
      new GetObjectCommand({ Bucket: this.bucketName(), Key: key }),
    );
    if (!result.Body) throw new Error('File is unavailable');
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async inspectObjectPrefix(
    key: string,
    maxBytes = 64,
  ): Promise<R2ObjectPrefixInspection> {
    const bucket = this.bucketName();
    const head = await this.client().send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    const contentLength = Number(head.ContentLength ?? 0);
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      return {
        contentLength: 0,
        ...(head.ContentType ? { contentType: head.ContentType } : {}),
        ...(head.ETag ? { etag: head.ETag } : {}),
        prefix: Buffer.alloc(0),
      };
    }
    const clampedEnd = Math.min(contentLength - 1, Math.max(1, maxBytes) - 1);
    const ranged = await this.client().send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: `bytes=0-${clampedEnd}`,
      }),
    );
    const prefix = ranged.Body
      ? Buffer.from(await ranged.Body.transformToByteArray()).subarray(
          0,
          Math.max(1, maxBytes),
        )
      : Buffer.alloc(0);
    return {
      contentLength,
      ...(head.ContentType ? { contentType: head.ContentType } : {}),
      ...(head.ETag ? { etag: head.ETag } : {}),
      prefix,
    };
  }

  async deleteObject(key: string): Promise<void> {
    await this.client().send(
      new DeleteObjectCommand({ Bucket: this.bucketName(), Key: key }),
    );
  }

  createUploadUrl(
    key: string,
    contentType: string,
    expiresInSeconds = 900,
  ): Promise<string> {
    return getSignedUrl(
      this.client(),
      new PutObjectCommand({
        Bucket: this.bucketName(),
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  createDownloadUrl(
    key: string,
    expiresInSeconds = 900,
    options?: R2DownloadUrlOptions,
  ): Promise<string> {
    return getSignedUrl(
      this.client(),
      new GetObjectCommand({
        Bucket: this.bucketName(),
        Key: key,
        ...(options?.responseContentDisposition
          ? { ResponseContentDisposition: options.responseContentDisposition }
          : {}),
        ...(options?.responseContentType
          ? { ResponseContentType: options.responseContentType }
          : {}),
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  private client(): S3Client {
    if (!this.endpoint || !this.accessKeyId || !this.secretAccessKey) {
      throw new Error('R2 storage is not configured');
    }
    if (!this.s3Client) {
      this.s3Client = new S3Client({
        region: 'auto',
        endpoint: this.endpoint,
        credentials: {
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey,
        },
      });
    }
    return this.s3Client;
  }

  private bucketName(): string {
    if (!this.bucket) {
      throw new Error('R2 bucket is not configured');
    }

    return this.bucket;
  }
}
