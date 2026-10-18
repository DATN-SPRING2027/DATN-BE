import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import type { Response } from 'express';
import { HealthResponse } from '../../../health/health.response';
import { PlatformIntegrationReadService } from '../application/platform-integration-read.service';
import { PlatformIntegrationOperationsService } from '../application/platform-integration-operations.service';
import { JiraApplicationService } from '../application/jira.service';
import { PlatformServiceOperationsGuard } from './platform-service-operations.guard';
import type {
  JiraConnectionStatus,
  PlatformIntegrationListInput,
} from '../application/platform-integration-read.repository';

function parseIntegrationOperationContext(
  body: unknown,
  allowedAdditionalKeys: readonly string[] = [],
): {
  actorUserId: string;
  idempotencyKey: string;
  correlationId?: string;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        ![
          'actorUserId',
          'idempotencyKey',
          'correlationId',
          ...allowedAdditionalKeys,
        ].includes(key),
    ) ||
    typeof record.actorUserId !== 'string' ||
    typeof record.idempotencyKey !== 'string' ||
    (record.correlationId !== undefined &&
      typeof record.correlationId !== 'string')
  )
    throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
  return {
    actorUserId: record.actorUserId,
    idempotencyKey: record.idempotencyKey,
    ...(typeof record.correlationId === 'string'
      ? { correlationId: record.correlationId }
      : {}),
  };
}

@Controller()
export class JiraController {
  constructor(
    private readonly service: JiraApplicationService,
    private readonly platformIntegrations: PlatformIntegrationReadService,
    private readonly platformIntegrationOperations: PlatformIntegrationOperationsService,
  ) {}

  @MessagePattern('jira.health')
  @Get('health')
  getHealth(): HealthResponse {
    return this.service.getHealth();
  }

  @Get('platform/integrations')
  @UseGuards(PlatformServiceOperationsGuard)
  listPlatformIntegrations(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.platformIntegrations.list(parseIntegrationQuery(query));
  }

  @Get('platform/integrations/:integrationId')
  @UseGuards(PlatformServiceOperationsGuard)
  findPlatformIntegration(
    @Param('integrationId') integrationId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.platformIntegrations.findById(integrationId);
  }

  @Post('platform/integrations/:integrationId/test-connection')
  @HttpCode(200)
  @UseGuards(PlatformServiceOperationsGuard)
  testPlatformIntegrationConnection(
    @Param('integrationId') integrationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.platformIntegrationOperations.testConnection({
      integrationId,
      ...parseIntegrationOperationContext(body),
    });
  }

  @Post('platform/integrations/:integrationId/reconnect')
  @HttpCode(200)
  @UseGuards(PlatformServiceOperationsGuard)
  reconnectPlatformIntegration(
    @Param('integrationId') integrationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const context = parseIntegrationOperationContext(body, [
      'expectedUpdatedAt',
    ]);
    const record = body as Record<string, unknown>;
    if (
      Object.keys(record).length !==
        3 + (record.correlationId === undefined ? 0 : 1) ||
      typeof record.expectedUpdatedAt !== 'string'
    )
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
    return this.platformIntegrationOperations.reconnect({
      integrationId,
      ...context,
      expectedUpdatedAt: record.expectedUpdatedAt,
    });
  }
}

function parseIntegrationQuery(
  query: Record<string, unknown>,
): PlatformIntegrationListInput {
  if (
    Object.keys(query).some(
      (key) =>
        !['page', 'pageSize', 'organizationId', 'projectId', 'status'].includes(
          key,
        ),
    )
  ) {
    throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
  }
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? 20 : Number(query.pageSize);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    (query.organizationId !== undefined &&
      typeof query.organizationId !== 'string') ||
    (query.projectId !== undefined && typeof query.projectId !== 'string') ||
    (query.status !== undefined && typeof query.status !== 'string')
  ) {
    throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
  }
  return {
    page,
    pageSize,
    ...(query.organizationId === undefined
      ? {}
      : { organizationId: query.organizationId }),
    ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
    ...(query.status === undefined
      ? {}
      : { status: query.status as JiraConnectionStatus }),
  };
}
