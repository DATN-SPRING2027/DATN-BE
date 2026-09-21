import { Injectable } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Registry,
} from 'prom-client';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly requests = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests handled by the process.',
    labelNames: ['method', 'route', 'status_code'],
    registers: [this.registry],
  });
  readonly duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds.',
    labelNames: ['method', 'route'],
    registers: [this.registry],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
