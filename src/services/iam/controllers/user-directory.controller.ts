import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Query,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';
import { UserDirectoryService } from '../application/users/user-directory.service';
import type {
  RoleCode,
  UserListQuery,
  UserStatus,
  UserUpdate,
} from '../application/users/user-directory.repository';

const statuses = new Set<UserStatus>(['ACTIVE', 'SUSPENDED', 'PENDING_INVITE']);
const roles = new Set<RoleCode>(['ADMIN', 'TEAM_LEADER', 'MEMBER']);

function invalid(): never {
  throw new UnprocessableEntityException({
    code: 'VALIDATION_FAILED',
    message: 'Request validation failed.',
  });
}

function parsePositiveInteger(
  value: unknown,
  fallback: number,
  max?: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (max !== undefined && parsed > max))
    return invalid();
  return parsed;
}

function parseListQuery(query: Record<string, unknown>): UserListQuery {
  const page = parsePositiveInteger(query.page, 1);
  const pageSize = parsePositiveInteger(query.pageSize, 20, 100);
  const status = query.status;
  const roleCode = query.roleCode;
  if (
    status !== undefined &&
    (typeof status !== 'string' || !statuses.has(status as UserStatus))
  )
    invalid();
  if (
    roleCode !== undefined &&
    (typeof roleCode !== 'string' || !roles.has(roleCode as RoleCode))
  )
    invalid();
  return {
    page,
    pageSize,
    ...(status === undefined ? {} : { status: status as UserStatus }),
    ...(roleCode === undefined ? {} : { roleCode: roleCode as RoleCode }),
  };
}

function parseUserId(value: string): string {
  if (!/^[a-fA-F0-9]{24}$/.test(value)) invalid();
  return value;
}

function parseUpdate(body: unknown): UserUpdate {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    invalid();
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length === 0 ||
    keys.some((key) => !['fullName', 'avatarUrl', 'status'].includes(key))
  )
    invalid();
  const changes: UserUpdate = {};
  if ('fullName' in record) {
    if (
      typeof record.fullName !== 'string' ||
      record.fullName.trim().length < 1 ||
      record.fullName.trim().length > 200
    )
      invalid();
    changes.fullName = record.fullName.trim();
  }
  if ('avatarUrl' in record) {
    if (record.avatarUrl !== null) {
      if (typeof record.avatarUrl !== 'string') invalid();
      try {
        const url = new URL(record.avatarUrl);
        if (!['http:', 'https:'].includes(url.protocol)) invalid();
      } catch {
        invalid();
      }
    }
    changes.avatarUrl = record.avatarUrl;
  }
  if ('status' in record) {
    if (
      typeof record.status !== 'string' ||
      !statuses.has(record.status as UserStatus)
    )
      invalid();
    changes.status = record.status as UserStatus;
  }
  return changes;
}

@Controller('iam/users')
export class UserDirectoryController {
  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly directory: UserDirectoryService,
  ) {}

  @Get()
  async list(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    return this.directory.list(actor, parseListQuery(query));
  }

  @Get(':userId')
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('userId') userId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    return this.directory.get(actor, parseUserId(userId));
  }

  @Patch(':userId')
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    return this.directory.update(actor, parseUserId(userId), parseUpdate(body));
  }
}
