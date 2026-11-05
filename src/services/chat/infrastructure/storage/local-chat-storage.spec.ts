import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ConfigService } from '@nestjs/config';
import { R2Storage } from './r2.storage';
import { S3Storage } from './s3.storage';

describe('Chat Local Enterprise Vault storage fallback', () => {
  it('persists R2 document and S3 image streams atomically in Local Vault without .env overrides even when cloud credentials exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chat-local-vault-test-'));
    const config = {
      get: (key: string) => {
        if (key === 'WORK_NOTE_LOCAL_STORAGE_DIR') return root;
        if (key === 'R2_ENDPOINT')
          return 'https://example.r2.cloudflarestorage.com';
        if (key === 'R2_BUCKET') return 'legacy-bucket';
        if (key === 'R2_ACCESS_KEY_ID') return 'legacy-key';
        if (key === 'R2_SECRET_ACCESS_KEY') return 'legacy-secret';
        if (key === 'AWS_REGION') return 'ap-southeast-2';
        if (key === 'CHAT_S3_BUCKET') return 'legacy-s3-bucket';
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

      // Verify staging directory has no leftover .part files
      expect(await readdir(join(root, '.staging'))).toHaveLength(0);

      // Verify headObject metadata
      expect(await r2.headObject(docKey)).toEqual({
        size: docBytes.length,
        contentType: 'application/pdf',
      });
      expect(await s3.headObject(imgKey)).toEqual({
        size: imgBytes.length,
        contentType: 'image/png',
      });

      // Verify download URL returns self-contained data URL
      const docUrl = await r2.createDownloadUrl(docKey, 300, {
        contentType: 'application/pdf',
        contentDisposition: 'attachment',
        filename: 'confidential.pdf',
      });
      expect(docUrl).toBe(
        `data:application/pdf;base64,${docBytes.toString('base64')}`,
      );

      // Verify path traversal is rejected
      await expect(r2.headObject('../outside')).rejects.toThrow(
        'Invalid chat object storage key',
      );

      // Verify deletion cleans up object and sidecar metadata
      await r2.deleteObject(docKey);
      await s3.deleteObject(imgKey);
      await expect(r2.headObject(docKey)).rejects.toThrow();
      await expect(s3.headObject(imgKey)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
