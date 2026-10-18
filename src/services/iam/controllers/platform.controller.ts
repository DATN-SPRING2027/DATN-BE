import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';
import { HealthResponse } from '../../../health/health.response';
import { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';
import type { AuthenticatedPlatformSubject } from '../application/authentication/authentication.application.service';
import { PlatformAuthorizationGuard } from '../application/authorization/platform-authorization.guard';
import { RequirePlatformPermission } from '../application/authorization/platform-permission.decorator';
import type {
  OrganizationPlan,
  OrganizationProvisioningInput,
} from '../application/organizations/organization-provisioning.repository';
import { OrganizationProvisioningService } from '../application/organizations/organization-provisioning.service';
import type { PlatformInvitationCommand } from '../application/organizations/organization-membership-command.repository';
import { IamApplicationService } from '../application/iam.service';
import { PlatformAuditService } from '../application/platform/platform-audit.service';
import type {
  PlatformAuditAction,
  PlatformAuditQuery,
  PlatformAuditResourceType,
} from '../application/platform/platform-audit.repository';
import { PlatformAdministrationService } from '../application/platform/platform-administration.service';
import { PlatformDashboardOverviewService } from '../application/platform/platform-dashboard-overview.service';
import { PlatformServiceOperationsService } from '../application/platform/platform-service-operations.service';
import { PlatformJobOperationsService } from '../application/platform/platform-job-operations.service';
import { PlatformAiOperationsService } from '../application/platform/platform-ai-operations.service';
import { PlatformIntegrationReadService } from '../application/platform/platform-integration-read.service';
import { PlatformIntegrationOperationsService } from '../application/platform/platform-integration-operations.service';
import { PlatformIncidentService } from '../application/platform/platform-incident.service';
import {
  PLATFORM_INCIDENT_SEVERITIES,
  PLATFORM_INCIDENT_STATUSES,
  type PlatformIncidentCommand,
  type PlatformIncidentListInput,
  type PlatformIncidentSeverity,
  type PlatformIncidentStatus,
} from '../application/platform/platform-incident.repository';
import {
  PLATFORM_JOB_FILTER_STATES,
  PLATFORM_QUEUE_IDS,
  type PlatformJobListInput,
  type PlatformJobFilterState,
  type PlatformJobCommand,
  type PlatformQueueId,
} from '../application/platform/platform-job-operations.repository';
import type {
  PlatformIntegrationListInput,
  PlatformIntegrationStatus,
} from '../application/platform/platform-integration-read.repository';
import type {
  PlatformMembershipListInput,
  PlatformProjectListInput,
  PlatformUserListInput,
  PlatformUserProfileChangeInput,
  PlatformUserArchiveInput,
  PlatformSessionListInput,
} from '../application/platform/platform-administration.repository';
import type { RoleCode } from '../application/users/user-directory.repository';
import {
  ORGANIZATION_MEMBERSHIP_STATUSES,
  type OrganizationMembershipStatus,
} from '../application/organizations/organization-membership-read.repository';
import {
  readCookie,
  validCsrfPair,
} from '../application/authentication/authentication.application.service';

function invalid(): never {
  throw new UnprocessableEntityException({
    code: 'VALIDATION_FAILED',
    message: 'Request validation failed.',
  });
}

const platformJobResourceIdPattern =
  /^(?:ingestion-queue|jira-sync-queue|mail-queue|handover-queue|universe-projection|dlq-failed-jobs):[A-Za-z0-9._:-]{1,200}$/;

function parseOrganizationInput(body: unknown): OrganizationProvisioningInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    invalid();
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !['name', 'slug', 'plan', 'firstAdminUserId'].includes(key),
    )
  )
    invalid();
  if (
    typeof record.name !== 'string' ||
    record.name.trim().length < 1 ||
    record.name.trim().length > 200 ||
    typeof record.slug !== 'string' ||
    record.slug.trim().length < 1 ||
    record.slug.trim().length > 100 ||
    typeof record.plan !== 'string' ||
    !['FREE', 'ENTERPRISE'].includes(record.plan) ||
    typeof record.firstAdminUserId !== 'string' ||
    !/^[a-fA-F0-9]{24}$/.test(record.firstAdminUserId)
  )
    invalid();
  return {
    name: record.name.trim(),
    slug: record.slug.trim().toLowerCase(),
    plan: record.plan as OrganizationPlan,
    firstAdminUserId: record.firstAdminUserId,
  };
}

function parsePageQuery(query: Record<string, unknown>): {
  page: number;
  pageSize: number;
} {
  if (
    Object.keys(query).some((key) => !['page', 'pageSize'].includes(key)) ||
    (query.page !== undefined && typeof query.page !== 'string') ||
    (query.pageSize !== undefined && typeof query.pageSize !== 'string')
  )
    return invalid();
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? 20 : Number(query.pageSize);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    return invalid();
  return { page, pageSize };
}

function parseMembershipPageQuery(query: Record<string, unknown>): {
  page: number;
  pageSize: number;
  status?: OrganizationMembershipStatus;
} {
  if (
    Object.keys(query).some(
      (key) => !['page', 'pageSize', 'status'].includes(key),
    ) ||
    (query.status !== undefined && typeof query.status !== 'string')
  )
    return invalid();
  const { page, pageSize } = parsePageQuery(
    Object.fromEntries(
      Object.entries(query).filter(([key]) => key !== 'status'),
    ),
  );
  if (
    query.status !== undefined &&
    !ORGANIZATION_MEMBERSHIP_STATUSES.includes(
      query.status as OrganizationMembershipStatus,
    )
  )
    return invalid();
  return {
    page,
    pageSize,
    ...(query.status !== undefined
      ? { status: query.status as OrganizationMembershipStatus }
      : {}),
  };
}

function parsePlatformMembershipsQuery(
  query: Record<string, unknown>,
): PlatformMembershipListInput {
  const allowed = new Set([
    'page',
    'pageSize',
    'search',
    'status',
    'organizationId',
    'roleCode',
  ]);
  if (Object.keys(query).some((key) => !allowed.has(key))) invalid();
  const { page, pageSize } = parsePageQuery({
    ...(query.page === undefined ? {} : { page: query.page }),
    ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
  });
  if (
    query.search !== undefined &&
    (typeof query.search !== 'string' ||
      query.search.trim().length < 1 ||
      query.search.trim().length > 100)
  )
    invalid();
  if (
    query.status !== undefined &&
    (typeof query.status !== 'string' ||
      !ORGANIZATION_MEMBERSHIP_STATUSES.includes(
        query.status as OrganizationMembershipStatus,
      ))
  )
    invalid();
  if (
    query.organizationId !== undefined &&
    (typeof query.organizationId !== 'string' ||
      !/^[a-f\d]{24}$/i.test(query.organizationId))
  )
    invalid();
  if (
    query.roleCode !== undefined &&
    (typeof query.roleCode !== 'string' ||
      !['ADMIN', 'TEAM_LEADER', 'MEMBER'].includes(query.roleCode))
  )
    invalid();
  return {
    page,
    pageSize,
    ...(typeof query.search === 'string'
      ? { search: query.search.trim() }
      : {}),
    ...(typeof query.status === 'string'
      ? { status: query.status as OrganizationMembershipStatus }
      : {}),
    ...(typeof query.organizationId === 'string'
      ? { organizationId: query.organizationId }
      : {}),
    ...(typeof query.roleCode === 'string'
      ? { roleCode: query.roleCode as RoleCode }
      : {}),
  };
}

function parsePlatformJobsQuery(
  query: Record<string, unknown>,
): PlatformJobListInput {
  if (
    Object.keys(query).some(
      (key) => !['page', 'pageSize', 'queueId', 'status'].includes(key),
    ) ||
    (query.queueId !== undefined && typeof query.queueId !== 'string') ||
    (query.status !== undefined && typeof query.status !== 'string')
  )
    return invalid();
  const { page, pageSize } = parsePageQuery({
    ...(query.page === undefined ? {} : { page: query.page }),
    ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
  });
  const queueId = query.queueId;
  const status = query.status;
  if (
    (queueId !== undefined &&
      !(PLATFORM_QUEUE_IDS as readonly string[]).includes(queueId)) ||
    (status !== undefined &&
      !(PLATFORM_JOB_FILTER_STATES as readonly string[]).includes(status))
  )
    return invalid();
  return {
    page,
    pageSize,
    ...(queueId === undefined ? {} : { queueId: queueId as PlatformQueueId }),
    ...(status === undefined
      ? {}
      : { status: status as PlatformJobFilterState }),
  };
}

function parsePlatformIntegrationQuery(
  query: Record<string, unknown>,
): PlatformIntegrationListInput {
  if (
    Object.keys(query).some(
      (key) =>
        !['page', 'pageSize', 'organizationId', 'projectId', 'status'].includes(
          key,
        ),
    ) ||
    (query.organizationId !== undefined &&
      typeof query.organizationId !== 'string') ||
    (query.projectId !== undefined && typeof query.projectId !== 'string') ||
    (query.status !== undefined && typeof query.status !== 'string')
  )
    return invalid();
  const { page, pageSize } = parsePageQuery({
    ...(query.page === undefined ? {} : { page: query.page }),
    ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
  });
  if (
    (query.organizationId !== undefined &&
      !/^[a-f\d]{24}$/i.test(query.organizationId)) ||
    (query.projectId !== undefined &&
      !/^[a-f\d]{24}$/i.test(query.projectId)) ||
    (query.status !== undefined &&
      !['CONNECTED', 'EXPIRED', 'REVOKED'].includes(query.status))
  )
    return invalid();
  return {
    page,
    pageSize,
    ...(query.organizationId === undefined
      ? {}
      : { organizationId: query.organizationId }),
    ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
    ...(query.status === undefined
      ? {}
      : { status: query.status as PlatformIntegrationStatus }),
  };
}

function parsePlatformUsersQuery(
  query: Record<string, unknown>,
): PlatformUserListInput {
  const allowed = new Set([
    'page',
    'pageSize',
    'search',
    'status',
    'organizationId',
    'roleCode',
  ]);
  if (Object.keys(query).some((key) => !allowed.has(key))) invalid();
  const { page, pageSize } = parsePageQuery({
    ...(query.page === undefined ? {} : { page: query.page }),
    ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
  });
  if (
    query.search !== undefined &&
    (typeof query.search !== 'string' ||
      query.search.trim().length < 1 ||
      query.search.trim().length > 100)
  )
    invalid();
  if (
    query.status !== undefined &&
    (typeof query.status !== 'string' ||
      !['ACTIVE', 'SUSPENDED', 'PENDING_INVITE', 'ARCHIVED'].includes(
        query.status,
      ))
  )
    invalid();
  if (
    query.organizationId !== undefined &&
    (typeof query.organizationId !== 'string' ||
      !/^[a-fA-F0-9]{24}$/.test(query.organizationId))
  )
    invalid();
  if (
    query.roleCode !== undefined &&
    (typeof query.roleCode !== 'string' ||
      !['ADMIN', 'TEAM_LEADER', 'MEMBER'].includes(query.roleCode))
  )
    invalid();
  return {
    page,
    pageSize,
    ...(typeof query.search === 'string'
      ? { search: query.search.trim() }
      : {}),
    ...(typeof query.status === 'string'
      ? { status: query.status as PlatformUserListInput['status'] }
      : {}),
    ...(typeof query.organizationId === 'string'
      ? { organizationId: query.organizationId }
      : {}),
    ...(typeof query.roleCode === 'string'
      ? { roleCode: query.roleCode as RoleCode }
      : {}),
  };
}

function parsePlatformProjectsQuery(
  query: Record<string, unknown>,
): PlatformProjectListInput {
  const allowed = new Set([
    'page',
    'pageSize',
    'search',
    'organizationId',
    'visibility',
    'status',
  ]);
  if (Object.keys(query).some((key) => !allowed.has(key))) invalid();
  const { page, pageSize } = parsePageQuery({
    ...(query.page === undefined ? {} : { page: query.page }),
    ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
  });
  if (
    query.search !== undefined &&
    (typeof query.search !== 'string' ||
      query.search.trim().length < 1 ||
      query.search.trim().length > 100)
  )
    invalid();
  if (
    query.organizationId !== undefined &&
    (typeof query.organizationId !== 'string' ||
      !/^[a-fA-F0-9]{24}$/.test(query.organizationId))
  )
    invalid();
  if (
    query.visibility !== undefined &&
    (typeof query.visibility !== 'string' ||
      !['PRIVATE', 'PUBLIC'].includes(query.visibility))
  )
    invalid();
  if (
    query.status !== undefined &&
    (typeof query.status !== 'string' ||
      !['ACTIVE', 'ARCHIVED'].includes(query.status))
  )
    invalid();
  return {
    page,
    pageSize,
    ...(typeof query.search === 'string'
      ? { search: query.search.trim() }
      : {}),
    ...(typeof query.organizationId === 'string'
      ? { organizationId: query.organizationId }
      : {}),
    ...(typeof query.visibility === 'string'
      ? { visibility: query.visibility as 'PRIVATE' | 'PUBLIC' }
      : {}),
    ...(typeof query.status === 'string'
      ? { status: query.status as 'ACTIVE' | 'ARCHIVED' }
      : {}),
  };
}

function parsePlatformProjectMembershipQuery(
  projectId: string,
  query: Record<string, unknown>,
) {
  if (
    Object.keys(query).some(
      (key) => !['page', 'pageSize', 'search', 'status'].includes(key),
    )
  )
    invalid();
  const { page, pageSize } = parsePageQuery({
    ...(query.page === undefined ? {} : { page: query.page }),
    ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
  });
  if (
    query.search !== undefined &&
    (typeof query.search !== 'string' ||
      query.search.trim().length < 1 ||
      query.search.trim().length > 100)
  )
    invalid();
  if (
    query.status !== undefined &&
    (typeof query.status !== 'string' ||
      !['ACTIVE', 'INACTIVE'].includes(query.status))
  )
    invalid();
  return {
    projectId,
    page,
    pageSize,
    ...(typeof query.search === 'string'
      ? { search: query.search.trim() }
      : {}),
    ...(typeof query.status === 'string'
      ? { status: query.status as 'ACTIVE' | 'INACTIVE' }
      : {}),
  };
}

function parsePlatformSessionQuery(
  userId: string,
  query: Record<string, unknown>,
): PlatformSessionListInput {
  if (
    Object.keys(query).some(
      (key) => !['page', 'pageSize', 'status'].includes(key),
    )
  )
    invalid();
  const { page, pageSize } = parsePageQuery({
    ...(query.page === undefined ? {} : { page: query.page }),
    ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
  });
  if (
    query.status !== undefined &&
    (typeof query.status !== 'string' ||
      !['ACTIVE', 'REVOKED', 'EXPIRED'].includes(query.status))
  )
    invalid();
  return {
    userId,
    page,
    pageSize,
    ...(typeof query.status === 'string'
      ? { status: query.status as 'ACTIVE' | 'REVOKED' | 'EXPIRED' }
      : {}),
  };
}

function parseSessionId(value: string): string {
  if (
    !/^(?:[a-f\d]{24}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(
      value,
    )
  )
    invalid();
  return value;
}

function parseSessionReason(body: unknown): {
  reasonCode: 'SECURITY_INCIDENT' | 'ACCESS_REVIEW';
} {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !('reasonCode' in body) ||
    !['SECURITY_INCIDENT', 'ACCESS_REVIEW'].includes(String(body.reasonCode))
  )
    invalid();
  return {
    reasonCode: body.reasonCode as 'SECURITY_INCIDENT' | 'ACCESS_REVIEW',
  };
}

function parseSessionVersion(body: unknown): {
  expectedUpdatedAt: Date;
  reasonCode: 'SECURITY_INCIDENT' | 'ACCESS_REVIEW';
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    invalid();
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !['expectedUpdatedAt', 'reasonCode'].includes(key),
    ) ||
    typeof record.expectedUpdatedAt !== 'string' ||
    !['SECURITY_INCIDENT', 'ACCESS_REVIEW'].includes(String(record.reasonCode))
  )
    invalid();
  const expectedUpdatedAt = new Date(record.expectedUpdatedAt);
  if (
    !Number.isFinite(expectedUpdatedAt.getTime()) ||
    expectedUpdatedAt.toISOString() !== record.expectedUpdatedAt
  )
    invalid();
  return {
    expectedUpdatedAt,
    reasonCode: record.reasonCode as 'SECURITY_INCIDENT' | 'ACCESS_REVIEW',
  };
}

function parseBulkSessionRevoke(body: unknown): {
  sessions: Array<{ sessionId: string; expectedUpdatedAt: Date }>;
  reasonCode: 'SECURITY_INCIDENT' | 'ACCESS_REVIEW';
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    invalid();
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !['sessions', 'reasonCode'].includes(key),
    ) ||
    !Array.isArray(record.sessions) ||
    record.sessions.length < 1 ||
    record.sessions.length > 100 ||
    !['SECURITY_INCIDENT', 'ACCESS_REVIEW'].includes(String(record.reasonCode))
  )
    invalid();
  const sessions = record.sessions.map((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      invalid();
    const item = value as Record<string, unknown>;
    if (
      Object.keys(item).length !== 2 ||
      typeof item.sessionId !== 'string' ||
      typeof item.expectedUpdatedAt !== 'string'
    )
      invalid();
    const expectedUpdatedAt = new Date(item.expectedUpdatedAt);
    if (
      !Number.isFinite(expectedUpdatedAt.getTime()) ||
      expectedUpdatedAt.toISOString() !== item.expectedUpdatedAt
    )
      invalid();
    return {
      sessionId: parseSessionId(item.sessionId),
      expectedUpdatedAt,
    };
  });
  return {
    sessions,
    reasonCode: record.reasonCode as 'SECURITY_INCIDENT' | 'ACCESS_REVIEW',
  };
}

function parseUserLookup(body: unknown): string {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !('email' in body) ||
    typeof body.email !== 'string'
  )
    return invalid();
  return body.email;
}

function parsePlatformUserStatusChange(body: unknown): {
  status: 'ACTIVE' | 'SUSPENDED';
  expectedUpdatedAt: Date;
  reasonCode: 'SECURITY_INCIDENT' | 'ACCESS_REVIEW';
} {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 3 ||
    !('status' in body) ||
    !('expectedUpdatedAt' in body) ||
    !('reasonCode' in body) ||
    !['ACTIVE', 'SUSPENDED'].includes(String(body.status)) ||
    typeof body.expectedUpdatedAt !== 'string' ||
    !['SECURITY_INCIDENT', 'ACCESS_REVIEW'].includes(String(body.reasonCode))
  )
    return invalid();
  const expectedUpdatedAt = new Date(body.expectedUpdatedAt);
  if (
    !Number.isFinite(expectedUpdatedAt.getTime()) ||
    expectedUpdatedAt.toISOString() !== body.expectedUpdatedAt
  )
    return invalid();
  return {
    status: body.status as 'ACTIVE' | 'SUSPENDED',
    expectedUpdatedAt,
    reasonCode: body.reasonCode as 'SECURITY_INCIDENT' | 'ACCESS_REVIEW',
  };
}

function parsePlatformUserProfileChange(
  body: unknown,
): Pick<
  PlatformUserProfileChangeInput,
  'fullName' | 'avatarUrl' | 'expectedUpdatedAt'
> {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    invalid();
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length < 2 ||
    keys.some(
      (key) => !['fullName', 'avatarUrl', 'expectedUpdatedAt'].includes(key),
    ) ||
    !('expectedUpdatedAt' in record) ||
    (!('fullName' in record) && !('avatarUrl' in record)) ||
    ('fullName' in record &&
      (typeof record.fullName !== 'string' ||
        record.fullName.trim().length < 1 ||
        record.fullName.trim().length > 200))
  )
    invalid();
  if (typeof record.expectedUpdatedAt !== 'string') invalid();
  const expectedUpdatedAt = new Date(record.expectedUpdatedAt);
  if (
    !Number.isFinite(expectedUpdatedAt.getTime()) ||
    expectedUpdatedAt.toISOString() !== record.expectedUpdatedAt
  )
    invalid();

  let avatarUrl: string | null | undefined;
  if ('avatarUrl' in record) {
    if (record.avatarUrl === null) avatarUrl = null;
    else if (typeof record.avatarUrl === 'string') {
      if (record.avatarUrl.length > 2000) invalid();
      try {
        const url = new URL(record.avatarUrl);
        if (!['http:', 'https:'].includes(url.protocol)) invalid();
      } catch {
        invalid();
      }
      avatarUrl = record.avatarUrl;
    } else invalid();
  }

  return {
    ...(typeof record.fullName === 'string'
      ? { fullName: record.fullName.trim() }
      : {}),
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
    expectedUpdatedAt,
  };
}

function parsePlatformUserArchive(
  body: unknown,
): Pick<PlatformUserArchiveInput, 'expectedUpdatedAt' | 'reasonCode'> {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 2 ||
    !('expectedUpdatedAt' in body) ||
    !('reasonCode' in body) ||
    typeof body.expectedUpdatedAt !== 'string' ||
    !['SECURITY_INCIDENT', 'ACCESS_REVIEW'].includes(String(body.reasonCode))
  )
    invalid();
  const expectedUpdatedAt = new Date(body.expectedUpdatedAt);
  if (
    !Number.isFinite(expectedUpdatedAt.getTime()) ||
    expectedUpdatedAt.toISOString() !== body.expectedUpdatedAt
  )
    invalid();
  return {
    expectedUpdatedAt,
    reasonCode: body.reasonCode as 'SECURITY_INCIDENT' | 'ACCESS_REVIEW',
  };
}

function parsePlatformSuspend(body: unknown): {
  expectedMembershipVersion: number;
  reasonCode: 'SECURITY_INCIDENT' | 'ACCESS_REVIEW';
} {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 2 ||
    !('expectedMembershipVersion' in body) ||
    !('reasonCode' in body) ||
    !Number.isSafeInteger(body.expectedMembershipVersion) ||
    Number(body.expectedMembershipVersion) < 1 ||
    !['SECURITY_INCIDENT', 'ACCESS_REVIEW'].includes(String(body.reasonCode))
  )
    return invalid();
  return {
    expectedMembershipVersion: Number(body.expectedMembershipVersion),
    reasonCode: body.reasonCode as 'SECURITY_INCIDENT' | 'ACCESS_REVIEW',
  };
}

function parsePlatformInvite(body: unknown): PlatformInvitationCommand {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 2 ||
    !('email' in body) ||
    !('reasonCode' in body) ||
    typeof body.email !== 'string' ||
    !['ACCESS_REQUEST', 'ACCESS_REVIEW'].includes(String(body.reasonCode))
  )
    invalid();
  return {
    command: 'INVITE',
    email: body.email,
    reasonCode: body.reasonCode as 'ACCESS_REQUEST' | 'ACCESS_REVIEW',
  };
}

function parsePlatformInvitationAction(
  body: unknown,
  invitationId: string,
  command: 'RESEND' | 'CANCEL',
): PlatformInvitationCommand {
  if (
    !/^[a-f\d]{24}$/i.test(invitationId) ||
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body)
  )
    invalid();
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    !('expectedMembershipVersion' in record) ||
    !('expectedInvitationVersion' in record) ||
    !('reasonCode' in record) ||
    !Number.isSafeInteger(record.expectedMembershipVersion) ||
    Number(record.expectedMembershipVersion) < 1 ||
    !Number.isSafeInteger(record.expectedInvitationVersion) ||
    Number(record.expectedInvitationVersion) < 1
  )
    invalid();
  if (
    command === 'RESEND' &&
    !['ACCESS_REQUEST', 'ACCESS_REVIEW'].includes(String(record.reasonCode))
  )
    invalid();
  if (command === 'CANCEL' && record.reasonCode !== 'INVITATION_CANCELLED')
    invalid();
  return command === 'RESEND'
    ? {
        command,
        invitationId,
        expectedMembershipVersion: Number(record.expectedMembershipVersion),
        expectedInvitationVersion: Number(record.expectedInvitationVersion),
        reasonCode: record.reasonCode as 'ACCESS_REQUEST' | 'ACCESS_REVIEW',
      }
    : {
        command,
        invitationId,
        expectedMembershipVersion: Number(record.expectedMembershipVersion),
        expectedInvitationVersion: Number(record.expectedInvitationVersion),
        reasonCode: 'INVITATION_CANCELLED',
      };
}

function parsePlatformOrganizationMetadata(body: unknown): {
  name?: string;
  slug?: string;
  expectedUpdatedAt: Date;
  reasonCode: 'ACCESS_REVIEW' | 'SECURITY_INCIDENT';
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return invalid();
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        !['name', 'slug', 'expectedUpdatedAt', 'reasonCode'].includes(key),
    ) ||
    (!('name' in record) && !('slug' in record)) ||
    typeof record.expectedUpdatedAt !== 'string' ||
    !['ACCESS_REVIEW', 'SECURITY_INCIDENT'].includes(String(record.reasonCode))
  )
    return invalid();
  const expectedUpdatedAt = new Date(record.expectedUpdatedAt);
  if (
    !Number.isFinite(expectedUpdatedAt.getTime()) ||
    expectedUpdatedAt.toISOString() !== record.expectedUpdatedAt ||
    ('name' in record &&
      (typeof record.name !== 'string' ||
        record.name.trim().length < 1 ||
        record.name.trim().length > 200)) ||
    ('slug' in record &&
      (typeof record.slug !== 'string' ||
        record.slug.length > 100 ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.slug)))
  )
    return invalid();
  return {
    ...('name' in record ? { name: (record.name as string).trim() } : {}),
    ...('slug' in record ? { slug: record.slug as string } : {}),
    expectedUpdatedAt,
    reasonCode: record.reasonCode as 'ACCESS_REVIEW' | 'SECURITY_INCIDENT',
  };
}

function parsePlatformProjectMetadata(body: unknown): {
  name?: string;
  code?: string;
  visibility?: 'PRIVATE' | 'PUBLIC';
  expectedUpdatedAt: Date;
  reasonCode: 'ACCESS_REVIEW' | 'SECURITY_INCIDENT';
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return invalid();
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        ![
          'name',
          'code',
          'visibility',
          'expectedUpdatedAt',
          'reasonCode',
        ].includes(key),
    ) ||
    !['name', 'code', 'visibility'].some((key) => key in record) ||
    typeof record.expectedUpdatedAt !== 'string' ||
    !['ACCESS_REVIEW', 'SECURITY_INCIDENT'].includes(String(record.reasonCode))
  )
    return invalid();
  const expectedUpdatedAt = new Date(record.expectedUpdatedAt);
  if (
    !Number.isFinite(expectedUpdatedAt.getTime()) ||
    expectedUpdatedAt.toISOString() !== record.expectedUpdatedAt ||
    ('name' in record &&
      (typeof record.name !== 'string' ||
        record.name.trim().length < 1 ||
        record.name.trim().length > 200)) ||
    ('code' in record &&
      (typeof record.code !== 'string' ||
        !/^[A-Z][A-Z0-9_-]{1,31}$/.test(record.code))) ||
    ('visibility' in record &&
      (typeof record.visibility !== 'string' ||
        !['PRIVATE', 'PUBLIC'].includes(record.visibility)))
  )
    return invalid();
  return {
    ...('name' in record ? { name: (record.name as string).trim() } : {}),
    ...('code' in record ? { code: record.code as string } : {}),
    ...('visibility' in record
      ? { visibility: record.visibility as 'PRIVATE' | 'PUBLIC' }
      : {}),
    expectedUpdatedAt,
    reasonCode: record.reasonCode as 'ACCESS_REVIEW' | 'SECURITY_INCIDENT',
  };
}

function parsePlatformAuditQuery(
  query: Record<string, unknown>,
): PlatformAuditQuery {
  const allowed = new Set([
    'page',
    'pageSize',
    'actorUserId',
    'action',
    'resourceType',
    'resourceId',
    'organizationId',
    'from',
    'to',
  ]);
  if (Object.keys(query).some((key) => !allowed.has(key))) invalid();
  const { page, pageSize } = parsePageQuery({
    ...(query.page === undefined ? {} : { page: query.page }),
    ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
  });
  for (const id of ['actorUserId', 'organizationId']) {
    if (
      query[id] !== undefined &&
      (typeof query[id] !== 'string' || !/^[a-fA-F0-9]{24}$/.test(query[id]))
    )
      invalid();
  }
  if (
    query.resourceId !== undefined &&
    (typeof query.resourceId !== 'string' ||
      (query.resourceType === 'SESSION'
        ? !/^(?:[a-fA-F0-9]{24}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/.test(
            query.resourceId,
          )
        : query.resourceType === 'JOB'
          ? !platformJobResourceIdPattern.test(query.resourceId)
          : !/^[a-fA-F0-9]{24}$/.test(query.resourceId)))
  )
    invalid();
  if (
    query.action !== undefined &&
    (typeof query.action !== 'string' ||
      ![
        'organization.create',
        'platform.authority.granted',
        'platform.authority.revoked',
        'platform.user.status.changed',
        'platform.session.revoked',
        'platform.sessions.revoked_all',
        'ORGANIZATION_MEMBERSHIP_SUSPENDED',
        'platform.organization.metadata.changed',
        'platform.project.metadata.changed',
        'platform.job.retry',
        'platform.job.cancel',
      ].includes(query.action))
  )
    invalid();
  if (
    query.resourceType !== undefined &&
    (typeof query.resourceType !== 'string' ||
      ![
        'ORGANIZATION',
        'PLATFORM_AUTHORITY',
        'ORGANIZATION_MEMBERSHIP',
        'USER',
        'PROJECT',
        'SESSION',
        'JOB',
      ].includes(query.resourceType))
  )
    invalid();
  const parseTime = (value: unknown): Date | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') return invalid();
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
      return invalid();
    return date;
  };
  const from = parseTime(query.from);
  const to = parseTime(query.to);
  if (from && to && from.getTime() >= to.getTime()) invalid();
  return {
    page,
    pageSize,
    ...(typeof query.actorUserId === 'string'
      ? { actorUserId: query.actorUserId }
      : {}),
    ...(typeof query.action === 'string'
      ? { action: query.action as PlatformAuditAction }
      : {}),
    ...(typeof query.resourceType === 'string'
      ? { resourceType: query.resourceType as PlatformAuditResourceType }
      : {}),
    ...(typeof query.resourceId === 'string'
      ? { resourceId: query.resourceId }
      : {}),
    ...(typeof query.organizationId === 'string'
      ? { organizationId: query.organizationId }
      : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}

function parsePlatformIncidentListQuery(
  query: Record<string, unknown>,
): PlatformIncidentListInput {
  const allowed = new Set([
    'page',
    'pageSize',
    'status',
    'severity',
    'affectedServiceId',
  ]);
  if (
    Object.keys(query).some((key) => !allowed.has(key)) ||
    (query.status !== undefined && typeof query.status !== 'string') ||
    (query.severity !== undefined && typeof query.severity !== 'string') ||
    (query.affectedServiceId !== undefined &&
      typeof query.affectedServiceId !== 'string')
  )
    invalid();
  const { page, pageSize } = parsePageQuery({
    ...(query.page === undefined ? {} : { page: query.page }),
    ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
  });
  if (
    (typeof query.status === 'string' &&
      !PLATFORM_INCIDENT_STATUSES.includes(
        query.status as PlatformIncidentStatus,
      )) ||
    (typeof query.severity === 'string' &&
      !PLATFORM_INCIDENT_SEVERITIES.includes(
        query.severity as PlatformIncidentSeverity,
      )) ||
    (typeof query.affectedServiceId === 'string' &&
      !/^[a-z][a-z0-9-]{0,63}$/.test(query.affectedServiceId))
  )
    invalid();
  return {
    page,
    pageSize,
    ...(typeof query.status === 'string'
      ? { status: query.status as PlatformIncidentStatus }
      : {}),
    ...(typeof query.severity === 'string'
      ? { severity: query.severity as PlatformIncidentSeverity }
      : {}),
    ...(typeof query.affectedServiceId === 'string'
      ? { affectedServiceId: query.affectedServiceId }
      : {}),
  };
}

function parsePlatformIncidentCreate(body: unknown): PlatformIncidentCommand {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    invalid();
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    !('title' in record) ||
    !('severity' in record) ||
    !('affectedServiceId' in record) ||
    typeof record.title !== 'string' ||
    typeof record.severity !== 'string' ||
    !PLATFORM_INCIDENT_SEVERITIES.includes(
      record.severity as PlatformIncidentSeverity,
    ) ||
    typeof record.affectedServiceId !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(record.affectedServiceId)
  )
    invalid();
  return {
    command: 'CREATE',
    title: record.title,
    severity: record.severity as PlatformIncidentSeverity,
    affectedServiceId: record.affectedServiceId,
  };
}

function parsePlatformIntegrationReconnect(body: unknown): Date {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    invalid();
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    typeof record.expectedUpdatedAt !== 'string'
  )
    invalid();
  const expectedUpdatedAt = new Date(record.expectedUpdatedAt);
  if (
    !Number.isFinite(expectedUpdatedAt.getTime()) ||
    expectedUpdatedAt.toISOString() !== record.expectedUpdatedAt
  )
    invalid();
  return expectedUpdatedAt;
}

function parsePlatformIncidentAction(
  body: unknown,
  incidentId: string,
  command: 'ACKNOWLEDGE' | 'RESOLVE' | 'ADD_NOTE',
): PlatformIncidentCommand {
  if (
    !/^[a-f\d]{24}$/i.test(incidentId) ||
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body)
  )
    invalid();
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !('expectedVersion' in record) ||
    !('note' in record) ||
    !Number.isSafeInteger(record.expectedVersion) ||
    Number(record.expectedVersion) < 1 ||
    typeof record.note !== 'string'
  )
    invalid();
  return {
    command,
    incidentId,
    expectedVersion: Number(record.expectedVersion),
    note: record.note,
  };
}

function parsePlatformJobCommand(
  body: unknown,
  command: 'RETRY' | 'CANCEL',
): PlatformJobCommand {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    invalid();
  const record = body as Record<string, unknown>;
  const expectedStatuses =
    command === 'RETRY' ? ['FAILED'] : ['WAITING', 'DELAYED'];
  if (
    Object.keys(record).length !== 1 ||
    typeof record.expectedStatus !== 'string' ||
    !expectedStatuses.includes(record.expectedStatus)
  )
    invalid();
  return {
    command,
    expectedStatus: record.expectedStatus as 'FAILED' | 'WAITING' | 'DELAYED',
  } as PlatformJobCommand;
}

@Controller('iam/platform')
@UseGuards(PlatformAuthorizationGuard)
export class PlatformController {
  constructor(
    private readonly authentication: AuthenticationApplicationService,
    private readonly organizations: OrganizationProvisioningService,
    private readonly health: IamApplicationService,
    private readonly audit: PlatformAuditService,
    private readonly administration: PlatformAdministrationService,
    private readonly dashboardOverview: PlatformDashboardOverviewService,
    private readonly serviceOperations: PlatformServiceOperationsService,
    private readonly jobOperations: PlatformJobOperationsService,
    private readonly aiOperations: PlatformAiOperationsService,
    private readonly integrations: PlatformIntegrationReadService,
    private readonly integrationOperations: PlatformIntegrationOperationsService,
    private readonly incidents: PlatformIncidentService,
  ) {}

  @Post('organizations')
  @RequirePlatformPermission('organization.create')
  async createOrganization(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor: AuthenticatedPlatformSubject =
      await this.authentication.getCurrentPlatformSubject(
        authorization,
        cookie,
      );
    if (
      !authorization &&
      !validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader)
    )
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    return this.organizations.create(actor, parseOrganizationInput(body));
  }

  @Get('organizations')
  @RequirePlatformPermission('platform.organizations.organization.read')
  listOrganizations(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const { page, pageSize } = parsePageQuery(query);
    return this.administration.listOrganizations(page, pageSize);
  }

  @Get('organizations/:organizationId')
  @RequirePlatformPermission('platform.organizations.organization.read')
  findOrganization(
    @Param('organizationId') organizationId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.administration.findOrganization(organizationId);
  }

  @Patch('organizations/:organizationId')
  @RequirePlatformPermission('platform.organizations.organization.manage')
  async changeOrganizationMetadata(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (
      !authorization &&
      !validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader)
    )
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    if (
      correlationId !== undefined &&
      !/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)
    )
      invalid();
    const actor = await this.authentication.getCurrentPlatformSubject(
      authorization,
      cookie,
    );
    return this.administration.changeOrganizationMetadata({
      actorUserId: actor.id,
      organizationId,
      ...parsePlatformOrganizationMetadata(body),
      ...(correlationId ? { correlationId } : {}),
      now: new Date(),
    });
  }

  @Get('users')
  @RequirePlatformPermission('platform.users.account.read')
  listUsers(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.administration.listUsers(parsePlatformUsersQuery(query));
  }

  @Get('projects')
  @RequirePlatformPermission('platform.projects.project.read')
  listProjects(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.administration.listProjects(parsePlatformProjectsQuery(query));
  }

  @Get('projects/:projectId')
  @RequirePlatformPermission('platform.projects.project.read')
  findProject(
    @Param('projectId') projectId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.administration.findProject(projectId);
  }

  @Get('projects/:projectId/memberships')
  @RequirePlatformPermission('platform.projects.project.read')
  listPlatformProjectMemberships(
    @Param('projectId') projectId: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.administration.listProjectMemberships(
      parsePlatformProjectMembershipQuery(projectId, query),
    );
  }

  @Patch('projects/:projectId')
  @RequirePlatformPermission('platform.projects.project.manage')
  async changeProjectMetadata(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (
      !authorization &&
      !validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader)
    )
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    if (
      correlationId !== undefined &&
      !/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)
    )
      invalid();
    const actor = await this.authentication.getCurrentPlatformSubject(
      authorization,
      cookie,
    );
    return this.administration.changeProjectMetadata({
      actorUserId: actor.id,
      projectId,
      ...parsePlatformProjectMetadata(body),
      ...(correlationId ? { correlationId } : {}),
      now: new Date(),
    });
  }

  @Get('incidents')
  @RequirePlatformPermission('platform.incidents.incident.read')
  listPlatformIncidents(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.incidents.list(parsePlatformIncidentListQuery(query));
  }

  @Get('incidents/:incidentId')
  @RequirePlatformPermission('platform.incidents.incident.read')
  findPlatformIncident(
    @Param('incidentId') incidentId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.incidents.find(incidentId);
  }

  @Get('incidents/:incidentId/history')
  @RequirePlatformPermission('platform.incidents.incident.read')
  listPlatformIncidentHistory(
    @Param('incidentId') incidentId: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const { page, pageSize } = parsePageQuery(query);
    return this.incidents.listHistory({ incidentId, page, pageSize });
  }

  @Post('incidents')
  @HttpCode(201)
  @RequirePlatformPermission('platform.incidents.incident.manage')
  createPlatformIncident(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.executePlatformIncident(
      authorization,
      cookie,
      csrfHeader,
      idempotencyKey,
      correlationId,
      parsePlatformIncidentCreate(body),
      response,
    );
  }

  @Post('incidents/:incidentId/acknowledge')
  @HttpCode(200)
  @RequirePlatformPermission('platform.incidents.incident.manage')
  acknowledgePlatformIncident(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('incidentId') incidentId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.executePlatformIncident(
      authorization,
      cookie,
      csrfHeader,
      idempotencyKey,
      correlationId,
      parsePlatformIncidentAction(body, incidentId, 'ACKNOWLEDGE'),
      response,
    );
  }

  @Post('incidents/:incidentId/resolve')
  @HttpCode(200)
  @RequirePlatformPermission('platform.incidents.incident.manage')
  resolvePlatformIncident(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('incidentId') incidentId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.executePlatformIncident(
      authorization,
      cookie,
      csrfHeader,
      idempotencyKey,
      correlationId,
      parsePlatformIncidentAction(body, incidentId, 'RESOLVE'),
      response,
    );
  }

  @Post('incidents/:incidentId/notes')
  @HttpCode(200)
  @RequirePlatformPermission('platform.incidents.incident.manage')
  addPlatformIncidentNote(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('incidentId') incidentId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.executePlatformIncident(
      authorization,
      cookie,
      csrfHeader,
      idempotencyKey,
      correlationId,
      parsePlatformIncidentAction(body, incidentId, 'ADD_NOTE'),
      response,
    );
  }

  @Get('services')
  @RequirePlatformPermission('platform.services.service.read')
  @ApiOperation({
    summary: 'Read Platform service liveness and dependency readiness',
    description:
      'Probes each owned backend service readiness endpoint with a bounded timeout and returns only safe operational metadata.',
  })
  @ApiOkResponse({
    description:
      'Service status, liveness, readiness, MongoDB and Redis dependency state, last check time, and safe diagnostics summary.',
  })
  listServices(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.serviceOperations.listServices();
  }

  @Get('services/:serviceId')
  @RequirePlatformPermission('platform.services.service.read')
  @ApiOperation({
    summary: 'Read readiness for one Platform service',
    description:
      'Returns only the selected service health projection. Upstream errors, URLs, response bodies, and credentials are not returned.',
  })
  @ApiOkResponse({ description: 'Safe operational service health projection.' })
  findService(
    @Param('serviceId') serviceId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.serviceOperations.findService(serviceId);
  }

  @Get('queues')
  @RequirePlatformPermission('platform.jobs.job.read')
  @ApiOperation({
    summary: 'List BullMQ queues and operational health',
    description:
      'Reads live queue depth, state counts, and paused/available state from the configured BullMQ Redis runtime. Unavailable queues return null counts, never fabricated zeroes.',
  })
  @ApiOkResponse({ description: 'Safe queue health projections.' })
  listQueues(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.jobOperations.listQueues();
  }

  @Get('queues/:queueId')
  @RequirePlatformPermission('platform.jobs.job.read')
  @ApiOperation({
    summary: 'Read one BullMQ queue operational projection',
    description:
      'Requires platform.jobs.job.read at PLATFORM scope. Returns live queue health from the configured BullMQ runtime.',
  })
  @ApiOkResponse({ description: 'Safe queue health projection.' })
  findQueue(
    @Param('queueId') queueId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.jobOperations.findQueue(queueId);
  }

  @Get('jobs')
  @RequirePlatformPermission('platform.jobs.job.read')
  @ApiOperation({
    summary: 'List BullMQ jobs using safe metadata projections',
    description:
      'Reads real jobs from the configured BullMQ queues. Payload, job result, raw failure text, and tenant content are excluded.',
  })
  @ApiOkResponse({ description: 'Paginated safe job metadata projection.' })
  listJobs(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.jobOperations.listJobs(parsePlatformJobsQuery(query));
  }

  @Get('jobs/:queueId/:jobId')
  @RequirePlatformPermission('platform.jobs.job.read')
  @ApiOperation({
    summary: 'Read one BullMQ job using a safe metadata projection',
    description:
      'Requires platform.jobs.job.read at PLATFORM scope. Returns job lifecycle timestamps and attempt counts only. Payload, result, and raw failure text are withheld.',
  })
  @ApiOkResponse({ description: 'Safe job metadata projection.' })
  findJob(
    @Param('queueId') queueId: string,
    @Param('jobId') jobId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.jobOperations.findJob(queueId, jobId);
  }

  @Post('jobs/:queueId/:jobId/retry')
  @HttpCode(200)
  @RequirePlatformPermission('platform.jobs.job.manage')
  retryJob(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('queueId') queueId: string,
    @Param('jobId') jobId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.executePlatformJobCommand(
      authorization,
      cookie,
      csrfHeader,
      idempotencyKey,
      correlationId,
      queueId,
      jobId,
      parsePlatformJobCommand(body, 'RETRY'),
      response,
    );
  }

  @Post('jobs/:queueId/:jobId/cancel')
  @HttpCode(200)
  @RequirePlatformPermission('platform.jobs.job.manage')
  cancelJob(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('queueId') queueId: string,
    @Param('jobId') jobId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.executePlatformJobCommand(
      authorization,
      cookie,
      csrfHeader,
      idempotencyKey,
      correlationId,
      queueId,
      jobId,
      parsePlatformJobCommand(body, 'CANCEL'),
      response,
    );
  }

  @Get('ai/operations')
  @RequirePlatformPermission('platform.ai.operations.read')
  @ApiOperation({
    summary: 'Read external SAG and RAG operational status',
    description:
      'Probes SAG health and readiness through its service boundary. It returns safe process, database, and knowledge runtime status only; model/provider and processing job details are not exposed by the current SAG operational API.',
  })
  @ApiOkResponse({ description: 'Safe SAG and RAG operational projection.' })
  getAiOperations(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.aiOperations.getStatus();
  }

  @Get('integrations')
  @RequirePlatformPermission('platform.integrations.integration.read')
  @ApiOperation({
    summary: 'List safe Jira integration metadata',
    description:
      'Reads Jira-owned connections through its signed internal service boundary. Credentials, webhook secrets, and site URLs are excluded. The current Jira owner does not provide connection test or reconnect operations.',
  })
  @ApiOkResponse({ description: 'Paginated safe Jira integration metadata.' })
  listIntegrations(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.integrations.list(parsePlatformIntegrationQuery(query));
  }

  @Get('integrations/:integrationId')
  @RequirePlatformPermission('platform.integrations.integration.read')
  @ApiOperation({
    summary: 'Read safe metadata for one Jira integration',
    description:
      'Requires platform.integrations.integration.read at PLATFORM scope. Credentials, webhook secrets, and site URLs are excluded.',
  })
  @ApiOkResponse({ description: 'Safe Jira integration metadata projection.' })
  findIntegration(
    @Param('integrationId') integrationId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.integrations.findById(integrationId);
  }

  @Post('integrations/:integrationId/test')
  @HttpCode(200)
  @RequirePlatformPermission('platform.integrations.integration.manage')
  async testIntegrationConnection(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('integrationId') integrationId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (!validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader))
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    if (
      correlationId !== undefined &&
      !/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)
    )
      invalid();
    const actor = await this.authentication.getCurrentPlatformSubject(
      authorization,
      cookie,
    );
    return this.integrationOperations.testConnection({
      actorUserId: actor.id,
      integrationId,
      idempotencyKey: idempotencyKey ?? '',
      ...(correlationId ? { correlationId } : {}),
    });
  }

  @Post('integrations/:integrationId/reconnect')
  @HttpCode(200)
  @RequirePlatformPermission('platform.integrations.integration.manage')
  async reconnectIntegration(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('integrationId') integrationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (!validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader))
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    if (
      correlationId !== undefined &&
      !/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)
    )
      invalid();
    const actor = await this.authentication.getCurrentPlatformSubject(
      authorization,
      cookie,
    );
    return this.integrationOperations.reconnect({
      actorUserId: actor.id,
      integrationId,
      idempotencyKey: idempotencyKey ?? '',
      expectedUpdatedAt: parsePlatformIntegrationReconnect(body),
      ...(correlationId ? { correlationId } : {}),
    });
  }

  @Get('dashboard')
  @RequirePlatformPermission('platform.dashboard.summary.read')
  getDashboardSummary(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.dashboardOverview.getOverview();
  }

  @Get('users/:userId')
  @RequirePlatformPermission('platform.users.account.read')
  findUser(
    @Param('userId') userId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.administration.findUser(userId);
  }

  @Patch('users/:userId')
  @RequirePlatformPermission('platform.users.account.manage')
  async updateUserProfile(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (
      !authorization &&
      !validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader)
    )
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    if (
      correlationId !== undefined &&
      !/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)
    )
      invalid();
    const actor = await this.authentication.getCurrentPlatformSubject(
      authorization,
      cookie,
    );
    return this.administration.updateUserProfile({
      actorUserId: actor.id,
      userId,
      ...parsePlatformUserProfileChange(body),
      ...(correlationId ? { correlationId } : {}),
      now: new Date(),
    });
  }

  @Post('users/:userId/archive')
  @RequirePlatformPermission('platform.users.account.manage')
  async archiveUser(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (
      !authorization &&
      !validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader)
    )
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    if (
      correlationId !== undefined &&
      !/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)
    )
      invalid();
    const actor = await this.authentication.getCurrentPlatformSubject(
      authorization,
      cookie,
    );
    return this.administration.archiveUser({
      actorUserId: actor.id,
      userId,
      ...parsePlatformUserArchive(body),
      ...(correlationId ? { correlationId } : {}),
      now: new Date(),
    });
  }

  @Patch('users/:userId/status')
  @RequirePlatformPermission('platform.users.account.manage')
  async changeUserStatus(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (
      !authorization &&
      !validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader)
    )
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    if (
      correlationId !== undefined &&
      !/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)
    )
      invalid();
    const actor = await this.authentication.getCurrentPlatformSubject(
      authorization,
      cookie,
    );
    return this.administration.changeUserStatus({
      actorUserId: actor.id,
      userId,
      ...parsePlatformUserStatusChange(body),
      ...(correlationId ? { correlationId } : {}),
      now: new Date(),
    });
  }

  @Get('users/:userId/organizations')
  @RequirePlatformPermission('platform.users.account.read')
  listUserOrganizations(
    @Param('userId') userId: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.administration.listUserOrganizations({
      userId,
      ...parseMembershipPageQuery(query),
    });
  }

  @Get('users/:userId/sessions')
  @RequirePlatformPermission('platform.sessions.session.read')
  listUserSessions(
    @Param('userId') userId: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.administration.listUserSessions(
      parsePlatformSessionQuery(userId, query),
    );
  }

  @Get('users/:userId/sessions/:sessionId')
  @RequirePlatformPermission('platform.sessions.session.read')
  findUserSession(
    @Param('userId') userId: string,
    @Param('sessionId') sessionId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.administration.findUserSession(
      userId,
      parseSessionId(sessionId),
    );
  }

  @Post('users/:userId/sessions/:sessionId/revoke')
  @HttpCode(200)
  @RequirePlatformPermission('platform.sessions.session.manage')
  async revokeUserSession(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('userId') userId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (
      !authorization &&
      !validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader)
    )
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    if (
      correlationId !== undefined &&
      !/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)
    )
      invalid();
    const actor = await this.authentication.getCurrentPlatformSubject(
      authorization,
      cookie,
    );
    return this.administration.revokeUserSession({
      actorUserId: actor.id,
      userId,
      sessionId: parseSessionId(sessionId),
      ...parseSessionVersion(body),
      ...(correlationId ? { correlationId } : {}),
      now: new Date(),
    });
  }

  @Post('users/:userId/sessions/revoke-bulk')
  @HttpCode(200)
  @RequirePlatformPermission('platform.sessions.session.manage')
  async revokeUserSessions(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (
      !authorization &&
      !validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader)
    )
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    if (
      correlationId !== undefined &&
      !/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)
    )
      invalid();
    const actor = await this.authentication.getCurrentPlatformSubject(
      authorization,
      cookie,
    );
    return this.administration.revokeUserSessions({
      actorUserId: actor.id,
      userId,
      ...parseBulkSessionRevoke(body),
      ...(correlationId ? { correlationId } : {}),
      now: new Date(),
    });
  }

  @Post('users/:userId/sessions/revoke-all')
  @HttpCode(200)
  @RequirePlatformPermission('platform.sessions.session.manage')
  async revokeAllUserSessions(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (
      !authorization &&
      !validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader)
    )
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    if (
      correlationId !== undefined &&
      !/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)
    )
      invalid();
    const actor = await this.authentication.getCurrentPlatformSubject(
      authorization,
      cookie,
    );
    return this.administration.revokeAllUserSessions({
      actorUserId: actor.id,
      userId,
      ...parseSessionReason(body),
      ...(correlationId ? { correlationId } : {}),
      now: new Date(),
    });
  }

  @Post('users/lookup')
  @HttpCode(200)
  @RequirePlatformPermission('platform.users.account.read')
  async lookupUser(
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (!validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader))
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    return this.administration.lookupActiveUser(parseUserLookup(body));
  }

  @Get('organizations/:organizationId/memberships')
  @RequirePlatformPermission('platform.memberships.membership.read')
  listOrganizationMemberships(
    @Param('organizationId') organizationId: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.administration.listOrganizationMemberships({
      organizationId,
      ...parseMembershipPageQuery(query),
    });
  }

  @Get('organizations/:organizationId/invitations')
  @RequirePlatformPermission('platform.memberships.membership.read')
  listPlatformInvitations(
    @Param('organizationId') organizationId: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const { page, pageSize } = parsePageQuery(query);
    return this.administration.listPlatformInvitations({
      organizationId,
      page,
      pageSize,
    });
  }

  @Post('organizations/:organizationId/invitations')
  @HttpCode(201)
  @RequirePlatformPermission('platform.memberships.invitation.manage')
  invitePlatformMembership(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.executePlatformInvitation(
      authorization,
      cookie,
      csrfHeader,
      idempotencyKey,
      correlationId,
      organizationId,
      parsePlatformInvite(body),
      response,
    );
  }

  @Post('organizations/:organizationId/invitations/:invitationId/resend')
  @HttpCode(200)
  @RequirePlatformPermission('platform.memberships.invitation.manage')
  resendPlatformInvitation(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('organizationId') organizationId: string,
    @Param('invitationId') invitationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.executePlatformInvitation(
      authorization,
      cookie,
      csrfHeader,
      idempotencyKey,
      correlationId,
      organizationId,
      parsePlatformInvitationAction(body, invitationId, 'RESEND'),
      response,
    );
  }

  @Post('organizations/:organizationId/invitations/:invitationId/cancel')
  @HttpCode(200)
  @RequirePlatformPermission('platform.memberships.invitation.manage')
  cancelPlatformInvitation(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('organizationId') organizationId: string,
    @Param('invitationId') invitationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.executePlatformInvitation(
      authorization,
      cookie,
      csrfHeader,
      idempotencyKey,
      correlationId,
      organizationId,
      parsePlatformInvitationAction(body, invitationId, 'CANCEL'),
      response,
    );
  }

  @Get('memberships')
  @RequirePlatformPermission('platform.memberships.membership.read')
  listPlatformMemberships(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.administration.listPlatformMemberships(
      parsePlatformMembershipsQuery(query),
    );
  }

  @Get('memberships/:membershipId')
  @RequirePlatformPermission('platform.memberships.membership.read')
  findPlatformMembership(
    @Param('membershipId') membershipId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.administration.findPlatformMembership(membershipId);
  }

  @Post('organizations/:organizationId/memberships/:membershipId/suspend')
  @HttpCode(200)
  @RequirePlatformPermission('platform.memberships.lifecycle.manage')
  async suspendMembership(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('organizationId') organizationId: string,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (!validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader))
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    const actor = await this.authentication.getCurrentPlatformSubject(
      authorization,
      cookie,
    );
    const result = await this.administration.suspendMembership({
      actorUserId: actor.id,
      organizationId,
      membershipId,
      idempotencyKey: idempotencyKey ?? '',
      ...parsePlatformSuspend(body),
      ...(correlationId ? { correlationId } : {}),
    });
    response.status(result.httpStatus);
    response.setHeader('X-Idempotent-Replay', String(result.replayed));
    return result.body;
  }

  @Get('health')
  @RequirePlatformPermission('platform.health.read')
  @ApiOperation({
    summary: 'Read IAM process liveness',
    description:
      'Returns the existing IAM process liveness response only. It does not report MongoDB, Redis, BullMQ, or other dependency readiness.',
  })
  @ApiOkResponse({ type: HealthResponse })
  getHealth(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.health.getHealth();
  }

  @Get('audit')
  @RequirePlatformPermission('platform.audit.read')
  listAudit(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.audit.listOperationalMetadata();
  }

  @Get('audit/events')
  @RequirePlatformPermission('platform.audit.read')
  listAuditEvents(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.audit.listEvents(parsePlatformAuditQuery(query));
  }

  @Get('diagnostics/traces/:requestId')
  @RequirePlatformPermission('platform.diagnostics.trace.read')
  @ApiOperation({
    summary: 'Read a bounded safe audit trace for a request ID',
    description:
      'Searches persisted Platform audit events by exact request/correlation ID and returns at most 50 allow-listed event projections. It does not query raw application logs or tenant payloads.',
  })
  @ApiOkResponse({
    description: 'Safe request-linked operational audit trace.',
  })
  findRequestTrace(
    @Param('requestId') requestId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.audit.findRequestTrace(requestId);
  }

  @Get('audit/events/:eventId')
  @RequirePlatformPermission('platform.audit.read')
  findAuditEvent(
    @Param('eventId') eventId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.audit.findEvent(eventId);
  }

  @Get('audit/resources/:resourceType/:resourceId/history')
  @RequirePlatformPermission('platform.audit.read')
  listResourceAuditHistory(
    @Param('resourceType') resourceType: PlatformAuditResourceType,
    @Param('resourceId') resourceId: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const { page, pageSize } = parsePageQuery(query);
    return this.audit.listResourceHistory({
      resourceType,
      resourceId,
      page,
      pageSize,
    });
  }

  private async executePlatformInvitation(
    authorization: string | undefined,
    cookie: string | undefined,
    csrfHeader: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    organizationId: string,
    command: PlatformInvitationCommand,
    response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (!validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader))
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    if (
      correlationId !== undefined &&
      !/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)
    )
      invalid();
    const actor = await this.authentication.getCurrentPlatformSubject(
      authorization,
      cookie,
    );
    const result = await this.administration.executePlatformInvitationCommand({
      actorUserId: actor.id,
      organizationId,
      idempotencyKey: idempotencyKey ?? '',
      command,
      ...(correlationId ? { correlationId } : {}),
    });
    response.status(result.httpStatus);
    response.setHeader('X-Idempotent-Replay', String(result.replayed));
    return result.body;
  }

  private async executePlatformIncident(
    authorization: string | undefined,
    cookie: string | undefined,
    csrfHeader: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    command: PlatformIncidentCommand,
    response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (!validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader))
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    if (
      correlationId !== undefined &&
      !/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)
    )
      invalid();
    const actor = await this.authentication.getCurrentPlatformSubject(
      authorization,
      cookie,
    );
    const result = await this.incidents.execute({
      actorUserId: actor.id,
      idempotencyKey: idempotencyKey ?? '',
      command,
      ...(correlationId ? { correlationId } : {}),
    });
    response.status(result.httpStatus);
    response.setHeader('X-Idempotent-Replay', String(result.replayed));
    return result.body;
  }

  private async executePlatformJobCommand(
    authorization: string | undefined,
    cookie: string | undefined,
    csrfHeader: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    queueId: string,
    jobId: string,
    command: PlatformJobCommand,
    response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (!validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader))
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    if (
      correlationId !== undefined &&
      !/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)
    )
      invalid();
    const actor = await this.authentication.getCurrentPlatformSubject(
      authorization,
      cookie,
    );
    const result = await this.jobOperations.execute({
      actorUserId: actor.id,
      queueId: queueId as PlatformQueueId,
      jobId,
      idempotencyKey: idempotencyKey ?? '',
      command,
      ...(correlationId ? { correlationId } : {}),
    });
    response.setHeader('X-Idempotent-Replay', String(result.replayed));
    return result.body;
  }
}
