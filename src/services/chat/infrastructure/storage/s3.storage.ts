import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

@Injectable()
export class S3Storage implements ChatObjectStorage {
  private readonly region?: string;
  private readonly bucket?: string;
  private readonly accessKeyId?: string;
  private readonly secretAccessKey?: string;
  private clientInstance?: S3Client;

  constructor(config: ConfigService) {
    this.region = config.get<string>('AWS_REGION');
    this.bucket = config.get<string>('CHAT_S3_BUCKET');
    this.accessKeyId = config.get<string>('AWS_ACCESS_KEY_ID');
    this.secretAccessKey = config.get<string>('AWS_SECRET_ACCESS_KEY');
  }

  async putObject(
    key: string,
    body: Readable,
    contentType: string,
    size: number,
  ): Promise<void> {
    await this.client().send(
      new PutObjectCommand({
        Bucket: this.bucketName(),
        Key: key,
        Body: body,
        ContentLength: size,
        ContentType: contentType,
      }),
    );
  }

  createDownloadUrl(
    key: string,
    expiresInSeconds = 900,
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

  async headObject(key: string): Promise<StoredObjectMetadata> {
    const result = await this.client().send(
      new HeadObjectCommand({ Bucket: this.bucketName(), Key: key }),
    );
    return { size: result.ContentLength, contentType: result.ContentType };
  }

  async deleteObject(key: string): Promise<void> {
    await this.client().send(
      new DeleteObjectCommand({ Bucket: this.bucketName(), Key: key }),
    );
  }

  private client(): S3Client {
    if (this.clientInstance) return this.clientInstance;
    if (!this.region) throw new Error('AWS S3 region is not configured');
    const credentials =
      this.accessKeyId && this.secretAccessKey
        ? {
            accessKeyId: this.accessKeyId,
            secretAccessKey: this.secretAccessKey,
          }
        : undefined;
    this.clientInstance = new S3Client({
      region: this.region,
      ...(credentials ? { credentials } : {}),
    });
    return this.clientInstance;
  }

  private bucketName(): string {
    if (!this.bucket) throw new Error('Chat S3 bucket is not configured');
    return this.bucket;
  }
}
