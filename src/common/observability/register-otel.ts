import 'dotenv/config';

function resolveServiceName(): string {
  if (process.env.OTEL_SERVICE_NAME?.trim()) {
    return process.env.OTEL_SERVICE_NAME.trim();
  }

  const entrypoint = process.argv.join(' ').replaceAll('\\', '/');
  if (/services\/([a-z-]+)\/main(?:\.js)?/i.test(entrypoint)) {
    const service = /services\/([a-z-]+)\/main(?:\.js)?/i.exec(entrypoint)?.[1];
    if (service) return `continuum-${service.toLowerCase()}`;
  }
  if (/gateway\/main(?:\.js)?/i.test(entrypoint))
    return 'continuum-api-gateway';
  if (/workers?\/main(?:\.js)?/i.test(entrypoint)) return 'continuum-worker';
  return 'continuum-backend';
}

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) {
  process.env.OTEL_SERVICE_NAME = resolveServiceName();
  // Load before Nest, HTTP clients, MongoDB, and Redis are imported.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@opentelemetry/auto-instrumentations-node/register');
}
