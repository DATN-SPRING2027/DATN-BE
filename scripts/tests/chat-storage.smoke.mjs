import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

if (process.env.NODE_ENV !== 'development')
  throw new Error('This test is restricted to development');
const require = createRequire(import.meta.url);
require('reflect-metadata');
const { ConfigService } = require('@nestjs/config');
const { S3Storage } = require('../../dist/services/chat/infrastructure/storage/s3.storage.js');
const { R2Storage } = require('../../dist/services/chat/infrastructure/storage/r2.storage.js');
const config = new ConfigService(process.env);
const results = [];
for (const [provider, storage, contentType, contentDisposition, filename, bytes] of [
  ['S3', new S3Storage(config), 'image/png', 'inline', 'chat-preview.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')],
  ['R2', new R2Storage(config), 'text/plain', 'attachment', 'chat-download.txt', Buffer.from('Chat download smoke test\n')],
]) {
  const key = `chat-smoke/${randomUUID()}/${filename}`;
  let uploaded = false;
  let stage = 'upload';
  const result = { provider, passed: false, cleaned: false };
  try {
    await storage.putObject(key, Readable.from(bytes), contentType, bytes.length);
    uploaded = true;
    stage = 'signed-download';
    const url = await storage.createDownloadUrl(key, 60, { contentType, contentDisposition, filename });
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    result.status = response.status;
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type')?.startsWith(contentType));
    assert.ok(response.headers.get('content-disposition')?.startsWith(contentDisposition));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    result.passed = true;
  } catch (error) {
    result.failedStage = stage;
    result.errorType = error.name;
    result.status ??= error.$metadata?.httpStatusCode;
  } finally {
    if (uploaded) {
      try {
        await storage.deleteObject(key);
        result.cleaned = true;
      } catch (error) {
        result.cleanupError = error.name;
      }
    }
  }
  results.push(result);
}
console.log(JSON.stringify(results, null, 2));
if (results.some((result) => !result.passed || !result.cleaned)) process.exitCode = 1;
