import { createHash, createHmac } from 'node:crypto';
import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  PlatformIntegrationOperationsRepository,
  PlatformIntegrationReconnectInput,
  PlatformIntegrationReconnectResult,
  PlatformIntegrationTestInput,
  PlatformIntegrationTestResult,
} from '../../application/platform/platform-integration-operations.repository';

const requestTimeoutMs = 3_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

@Injectable()
export class PlatformIntegrationOperationsHttpRepository implements PlatformIntegrationOperationsRepository {
  constructor(private readonly config: ConfigService) {}

  async testConnection(
    input: PlatformIntegrationTestInput,
  ): Promise<PlatformIntegrationTestResult> {
    const value = await this.post(input.integrationId, 'test-connection', {
      ...input,
    });
    if (
      !isRecord(value) ||
      value.integrationId !== input.integrationId ||
      !['CONNECTED', 'FAILED'].includes(String(value.status)) ||
      !isTimestamp(value.testedAt)
    )
      return this.unavailable();
    return {
      integrationId: input.integrationId,
      status: value.status as 'CONNECTED' | 'FAILED',
      testedAt: value.testedAt,
      failureSummary:
        value.status === 'FAILED'
          ? 'Jira connection test failed. Provider details are withheld.'
          : null,
    };
  }

  async reconnect(
    input: PlatformIntegrationReconnectInput,
  ): Promise<PlatformIntegrationReconnectResult> {
    const value = await this.post(input.integrationId, 'reconnect', {
      ...input,
      expectedUpdatedAt: input.expectedUpdatedAt.toISOString(),
    });
    if (
      !isRecord(value) ||
      value.integrationId !== input.integrationId ||
      !['CONNECTED', 'EXPIRED', 'REVOKED'].includes(String(value.status)) ||
      !isTimestamp(value.updatedAt)
    )
      return this.unavailable();
    return {
      integrationId: input.integrationId,
      status: value.status as 'CONNECTED' | 'EXPIRED' | 'REVOKED',
      updatedAt: value.updatedAt,
    };
  }

  private async post(
    integrationId: string,
    operation: 'test-connection' | 'reconnect',
    body: object,
  ): Promise<unknown> {
    const baseUrl = this.config.get<string>('JIRA_SERVICE_URL');
    const secret = this.config.get<string>('PLATFORM_SERVICE_OPS_SECRET');
    if (!baseUrl || !secret || secret.length < 32) return this.unavailable();
    let url: URL;
    try {
      url = new URL(
        `/internal/platform/integrations/${encodeURIComponent(integrationId)}/${operation}`,
        baseUrl,
      );
    } catch {
      return this.unavailable();
    }
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const serializedBody = JSON.stringify(body);
    const bodyHash = createHash('sha256').update(serializedBody).digest('hex');
    const canonical = `${timestamp}\nPOST\n${url.pathname}${url.search}\n${bodyHash}`;
    const signature = createHmac('sha256', secret)
      .update(canonical)
      .digest('hex');
    let response: globalThis.Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-platform-ops-timestamp': timestamp,
          'x-platform-ops-signature': signature,
        },
        body: serializedBody,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      return this.unavailable();
    }
    if (response.status === 404)
      throw new NotFoundException({ code: 'INTEGRATION_NOT_FOUND' });
    if (!response.ok) return this.unavailable();
    try {
      return await response.json();
    } catch {
      return this.unavailable();
    }
  }

  private unavailable(): never {
    throw new ServiceUnavailableException({
      code: 'PLATFORM_INTEGRATION_OPERATION_UNAVAILABLE',
    });
  }
}
