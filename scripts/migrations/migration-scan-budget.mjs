export const MIGRATION_SCAN_LIMITS = Object.freeze({
  cursorBatchSize: 100,
  maxDocuments: 100_000,
  maxEjsonDocumentBytes: 64 * 1024 * 1024,
  maxReportBytes: 32 * 1024 * 1024,
  maxHeapUsedBytes: 512 * 1024 * 1024,
});

export class MigrationScanBudget {
  #documentsScanned = 0;
  #ejsonDocumentBytes = 0;
  #reportBytes = 0;
  #started = process.memoryUsage();
  #peakHeapUsedBytes = this.#started.heapUsed;
  #peakRssBytes = this.#started.rss;

  addDocument(ejsonBytes) {
    if (this.#documentsScanned + 1 > MIGRATION_SCAN_LIMITS.maxDocuments) {
      throw new Error(
        `Migration scan exceeded the ${MIGRATION_SCAN_LIMITS.maxDocuments} document limit; refusing to build a partial report`,
      );
    }
    if (
      this.#ejsonDocumentBytes + ejsonBytes >
      MIGRATION_SCAN_LIMITS.maxEjsonDocumentBytes
    ) {
      throw new Error(
        `Migration scan exceeded the ${MIGRATION_SCAN_LIMITS.maxEjsonDocumentBytes} EJSON document-byte limit; refusing to build a partial report`,
      );
    }
    this.#documentsScanned += 1;
    this.#ejsonDocumentBytes += ejsonBytes;
    this.sampleHeap('document scan');
  }

  setReportBytes(bytes) {
    this.#reportBytes = bytes;
    if (bytes > MIGRATION_SCAN_LIMITS.maxReportBytes) {
      throw new Error(
        `Migration report exceeded the ${MIGRATION_SCAN_LIMITS.maxReportBytes} byte limit; refusing to emit a partial report`,
      );
    }
    this.sampleHeap('report serialization');
  }

  sampleHeap(stage) {
    const usage = process.memoryUsage();
    this.#peakHeapUsedBytes = Math.max(this.#peakHeapUsedBytes, usage.heapUsed);
    this.#peakRssBytes = Math.max(this.#peakRssBytes, usage.rss);
    if (usage.heapUsed > MIGRATION_SCAN_LIMITS.maxHeapUsedBytes) {
      throw new Error(
        `Migration scan exceeded the ${MIGRATION_SCAN_LIMITS.maxHeapUsedBytes} byte V8 heap limit during ${stage}; refusing to continue`,
      );
    }
  }

  metrics() {
    const end = process.memoryUsage();
    this.sampleHeap('scan completion');
    return {
      documentsScanned: this.#documentsScanned,
      ejsonDocumentBytes: this.#ejsonDocumentBytes,
      reportBytes: this.#reportBytes,
      heapUsedStartBytes: this.#started.heapUsed,
      heapUsedEndBytes: end.heapUsed,
      peakHeapUsedBytes: this.#peakHeapUsedBytes,
      peakRssBytes: this.#peakRssBytes,
      limits: MIGRATION_SCAN_LIMITS,
    };
  }
}
