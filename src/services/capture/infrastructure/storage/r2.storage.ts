import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

@Injectable()
export class R2Storage {
  private readonly endpoint?: string;
  private readonly accessKeyId?: string;
  private readonly secretAccessKey?: string;
  private readonly bucket?: string;

  constructor(config: ConfigService) {
    this.endpoint = config.get<string>('R2_ENDPOINT');
    this.accessKeyId = config.get<string>('R2_ACCESS_KEY_ID');
    this.secretAccessKey = config.get<string>('R2_SECRET_ACCESS_KEY');
    this.bucket = config.get<string>('R2_BUCKET');
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

  createDownloadUrl(key: string, expiresInSeconds = 900): Promise<string> {
    return getSignedUrl(
      this.client(),
      new GetObjectCommand({ Bucket: this.bucketName(), Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  private client(): S3Client {
    if (!this.endpoint || !this.accessKeyId || !this.secretAccessKey) {
      throw new Error('R2 storage is not configured');
    }

    return new S3Client({
      region: 'auto',
      endpoint: this.endpoint,
      credentials: {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
      },
    });
  }

  private bucketName(): string {
    if (!this.bucket) {
      throw new Error('R2 bucket is not configured');
    }

    return this.bucket;
  }
}
