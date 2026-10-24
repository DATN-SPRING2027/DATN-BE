import { BullMQOtel } from 'bullmq-otel';

export function createBullMqTelemetry(): BullMQOtel | undefined {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) return undefined;
  return new BullMQOtel({
    tracerName: 'continuum-bullmq',
    enableMetrics: false,
  });
}
