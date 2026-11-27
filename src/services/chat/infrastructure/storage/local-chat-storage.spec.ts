import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ConfigService } from '@nestjs/config';
import { R2Storage } from './r2.storage';
import { S3Storage } from './s3.storage';

async function readStreamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
    );
  }
  return Buffer.concat(chunks);
}

describe('Chat Storage mode & streaming vault (BE-DATA-002 / SEC-BE-002)', () => {
  it('enables cloud storage when credentials exist unless STORAGE_MODE=local or STORAGE_FORCE_LOCAL=true', () => {
    const cloudValues: Record<string, string> = {
      R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
      R2_BUCKET: 'prod-bucket',
      R2_ACCESS_KEY_ID: 'key',
      R2_SECRET_ACCESS_KEY: 'secret',
      AWS_REGION: 'ap-southeast-2',
      CHAT_S3_BUCKET: 'prod-s3-bucket',
    };
    const cloudConfig = {
      get: (key: string) => cloudValues[key],
    } as unknown as ConfigService;

    expect(new R2Storage(cloudConfig).isConfigured()).toBe(true);
    expect(new S3Storage(cloudConfig).isConfigured()).toBe(true);

    const localOverrideConfig = {
      get: (key: string) =>
        key === 'STORAGE_MODE' ? 'local' : cloudValues[key],
    } as unknown as ConfigService;

    expect(new R2Storage(localOverrideConfig).isConfigured()).toBe(false);
    expect(new S3Storage(localOverrideConfig).isConfigured()).toBe(false);

    const forceLocalConfig = {
      get: (key: string) =>
        key === 'STORAGE_FORCE_LOCAL' ? 'true' : cloudValues[key],
    } as unknown as ConfigService;

    expect(new R2Storage(forceLocalConfig).isConfigured()).toBe(false);
    expect(new S3Storage(forceLocalConfig).isConfigured()).toBe(false);

    const emptyDevConfig = {
      get: () => undefined,
    } as unknown as ConfigService;
    expect(new R2Storage(emptyDevConfig).isConfigured()).toBe(false);
    expect(new S3Storage(emptyDevConfig).isConfigured()).toBe(false);
  });

  it('streams local vault uploads/downloads without inline Base64 data URIs and rejects traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chat-local-vault-test-'));
    const config = {
      get: (key: string) => {
        if (key === 'WORK_NOTE_LOCAL_STORAGE_DIR') return root;
        if (key === 'STORAGE_MODE') return 'local';
        return undefined;
      },
    } as unknown as ConfigService;

    const r2 = new R2Storage(config);
    const s3 = new S3Storage(config);

    const docKey = 'chat/org1/conv1/user1/doc-uuid-1';
    const imgKey = 'chat/org1/conv1/user1/img-uuid-1';
    const docBytes = Buffer.from('%PDF-1.7 enterprise confidential');
    const imgBytes = Buffer.from('\x89PNG\r\n\x1a\nconfidential');

    try {
      await r2.putObject(
        docKey,
        Readable.from([docBytes]),
        'application/pdf',
        docBytes.length,
      );
      await s3.putObject(
        imgKey,
        Readable.from([imgBytes]),
        'image/png',
        imgBytes.length,
      );

      expect(await readdir(join(root, '.staging'))).toHaveLength(0);

      expect(await r2.headObject(docKey)).toEqual({
        size: docBytes.length,
        contentType: 'application/pdf',
      });
      expect(await s3.headObject(imgKey)).toEqual({
        size: imgBytes.length,
        contentType: 'image/png',
      });

      const localStreamUrl =
        '/api/v1/chat/conversations/conv1/attachments/att1/content';
      const docUrl = await r2.createDownloadUrl(docKey, 300, {
        contentType: 'application/pdf',
        contentDisposition: 'attachment',
        filename: 'confidential.pdf',
        localStreamUrl,
      });
      expect(docUrl).toBe(localStreamUrl);
      expect(docUrl.startsWith('data:')).toBe(false);

      await expect(
        r2.createDownloadUrl(docKey, 300, {
          contentType: 'application/pdf',
          contentDisposition: 'attachment',
          filename: 'confidential.pdf',
        }),
      ).rejects.toThrow('inline Base64 data URIs are disabled');

      const openedDoc = await r2.openReadStream(docKey);
      expect(openedDoc.size).toBe(docBytes.length);
      expect(openedDoc.contentType).toBe('application/pdf');
      expect(await readStreamToBuffer(openedDoc.stream)).toEqual(docBytes);

      const openedImg = await s3.openReadStream(imgKey);
      expect(await readStreamToBuffer(openedImg.stream)).toEqual(imgBytes);

      await expect(r2.headObject('../outside')).rejects.toThrow(
        'Invalid chat object storage key',
      );

      await r2.deleteObject(docKey);
      await s3.deleteObject(imgKey);
      await expect(r2.headObject(docKey)).rejects.toThrow();
      await expect(s3.headObject(imgKey)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
