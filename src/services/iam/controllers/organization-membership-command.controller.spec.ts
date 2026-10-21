import {
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  AuthenticationApplicationService,
  AuthenticatedIdentity,
} from '../application/authentication/authentication.application.service';
import type { OrganizationMembershipCommandService } from '../application/organizations/organization-membership-command.service';
import { OrganizationMembershipCommandController } from './organization-membership-command.controller';

const organizationId = '651a2b3c4d5e6f7a8b9c0d1f';
const actor: AuthenticatedIdentity = {
  id: '751a2b3c4d5e6f7a8b9c0d1f',
  email: 'admin@example.test',
  name: 'Admin',
  organizationId,
  roles: ['ADMIN'],
};

describe('OrganizationMembershipCommandController', () => {
  const auth = {
    getCurrentIdentity: jest.fn().mockResolvedValue(actor),
  };
  const commands = {
    execute: jest.fn().mockResolvedValue({
      httpStatus: 201,
      replayed: true,
      body: { operationId: '851a2b3c4d5e6f7a8b9c0d1f' },
    }),
    listInvitations: jest.fn().mockResolvedValue({ data: [], pagination: {} }),
    getOverview: jest.fn().mockResolvedValue({
      organization: {
        id: organizationId,
        name: 'Continuum',
        slug: 'continuum',
      },
      metrics: { totalMembersCount: 4, leaderlessProjectsCount: 1 },
      leaderlessProjects: [],
      managers: [],
    }),
    getSettings: jest.fn().mockResolvedValue({
      id: organizationId,
      name: 'Continuum',
      slug: 'continuum',
      editableFields: ['name', 'description'],
    }),
    updateSettings: jest.fn().mockResolvedValue({
      id: organizationId,
      name: 'Continuum Updated',
      slug: 'continuum',
      editableFields: ['name', 'description'],
    }),
  };
  let controller: OrganizationMembershipCommandController;
  let response: { setHeader: jest.Mock; status: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new OrganizationMembershipCommandController(
      auth as unknown as AuthenticationApplicationService,
      commands as unknown as OrganizationMembershipCommandService,
    );
    response = { setHeader: jest.fn(), status: jest.fn() };
  });

  it('accepts only the exact invite request and propagates replay acknowledgement', async () => {
    const result = await controller.invite(
      'Bearer token',
      '__Host-csrf=csrf-token',
      'csrf-token',
      'stable-idempotency-key',
      'request-id',
      organizationId,
      { email: 'member@example.test', reasonCode: 'ACCESS_REQUEST' },
      response as never,
    );
    expect(commands.execute).toHaveBeenCalledWith(
      actor,
      organizationId,
      'stable-idempotency-key',
      {
        command: 'INVITE',
        email: 'member@example.test',
        reasonCode: 'ACCESS_REQUEST',
      },
      'request-id',
    );
    expect(response.status).toHaveBeenCalledWith(201);
    expect(response.setHeader).toHaveBeenCalledWith(
      'Idempotency-Replayed',
      'true',
    );
    expect(result).toEqual({ operationId: '851a2b3c4d5e6f7a8b9c0d1f' });
  });

  it.each([
    ['resend', 'ACCESS_REVIEW'],
    ['cancel', 'INVITATION_CANCELLED'],
  ] as const)(
    'requires both CAS versions for invitation %s',
    async (action, reasonCode) => {
      const body = {
        expectedMembershipVersion: 0,
        expectedInvitationVersion: 2,
        reasonCode,
      };
      await controller[action](
        'Bearer token',
        '__Host-csrf=csrf-token',
        'csrf-token',
        'stable-idempotency-key',
        undefined,
        organizationId,
        'a51a2b3c4d5e6f7a8b9c0d1f',
        body,
        response as never,
      );
      expect(commands.execute).toHaveBeenCalledWith(
        actor,
        organizationId,
        'stable-idempotency-key',
        {
          command: action.toUpperCase(),
          invitationId: 'a51a2b3c4d5e6f7a8b9c0d1f',
          expectedMembershipVersion: 0,
          expectedInvitationVersion: 2,
          reasonCode,
        },
        undefined,
      );

      await expect(
        controller[action](
          'Bearer token',
          '__Host-csrf=csrf-token',
          'csrf-token',
          'stable-idempotency-key',
          undefined,
          organizationId,
          'a51a2b3c4d5e6f7a8b9c0d1f',
          { expectedInvitationVersion: 2, reasonCode },
          response as never,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    },
  );

  it('rejects missing reasonCode, invalid roleCode, and any unknown field', async () => {
    await expect(
      controller.invite(
        'Bearer token',
        '__Host-csrf=csrf-token',
        'csrf-token',
        'stable-idempotency-key',
        undefined,
        organizationId,
        { email: 'member@example.test', roleCode: 'ADMIN' },
        response as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      controller.invite(
        'Bearer token',
        '__Host-csrf=csrf-token',
        'csrf-token',
        'stable-idempotency-key',
        undefined,
        organizationId,
        {
          email: 'member@example.test',
          reasonCode: 'ACCESS_REQUEST',
          roleCode: 'TEAM_LEADER',
        },
        response as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      controller.invite(
        'Bearer token',
        '__Host-csrf=csrf-token',
        'csrf-token',
        'stable-idempotency-key',
        undefined,
        organizationId,
        {
          email: 'member@example.test',
          reasonCode: 'ACCESS_REQUEST',
          unknownField: true,
        },
        response as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it('accepts optional invitation configuration fields when valid', async () => {
    const projectId = 'a51a2b3c4d5e6f7a8b9c0d1f';
    await controller.invite(
      'Bearer token',
      '__Host-csrf=csrf-token',
      'csrf-token',
      'stable-idempotency-key',
      'request-id',
      organizationId,
      {
        email: 'member@example.test',
        reasonCode: 'ACCESS_REQUEST',
        roleCode: 'MEMBER',
        accessScope: 'SPECIFIC_PROJECTS',
        projectIds: [projectId],
        message: 'Welcome to our organization',
        expiresInDays: 14,
        requireApproval: true,
      },
      response as never,
    );
    expect(commands.execute).toHaveBeenCalledWith(
      actor,
      organizationId,
      'stable-idempotency-key',
      {
        command: 'INVITE',
        email: 'member@example.test',
        reasonCode: 'ACCESS_REQUEST',
        roleCode: 'MEMBER',
        accessScope: 'SPECIFIC_PROJECTS',
        projectIds: [projectId],
        message: 'Welcome to our organization',
        expiresInDays: 14,
        requireApproval: true,
      },
      'request-id',
    );
  });

  it('requires matching CSRF cookie and header before sending a command', async () => {
    await expect(
      controller.invite(
        'Bearer token',
        '__Host-csrf=csrf-token',
        'other-token',
        'stable-idempotency-key',
        undefined,
        organizationId,
        { email: 'member@example.test', reasonCode: 'ACCESS_REQUEST' },
        response as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it('parses the exact Organization role request and returns the replay contract', async () => {
    const membershipId = '951a2b3c4d5e6f7a8b9c0d1f';
    const body = {
      operationId: '851a2b3c4d5e6f7a8b9c0d1f',
      membership: {
        id: membershipId,
        organizationId,
        userId: 'a51a2b3c4d5e6f7a8b9c0d1f',
        status: 'ACTIVE',
        version: 3,
      },
      role: { roleCode: 'ADMIN', version: 2 },
    };
    commands.execute.mockResolvedValueOnce({
      httpStatus: 200,
      replayed: true,
      body,
    });

    const result = await controller.setOrganizationRole(
      'Bearer token',
      '__Host-csrf=csrf-token',
      'csrf-token',
      'stable-idempotency-key',
      undefined,
      organizationId,
      membershipId,
      {
        expectedMembershipVersion: 3,
        expectedRoleVersion: 1,
        roleCode: 'ADMIN',
        reason: 'Approved access review',
      },
      { requestId: 'request-id' } as never,
      response as never,
    );

    expect(commands.execute).toHaveBeenCalledWith(
      actor,
      organizationId,
      'stable-idempotency-key',
      {
        command: 'SET_ORGANIZATION_ROLE',
        membershipId,
        expectedMembershipVersion: 3,
        expectedRoleVersion: 1,
        roleCode: 'ADMIN',
        reason: 'Approved access review',
      },
      'request-id',
    );
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.setHeader).toHaveBeenCalledWith(
      'Idempotency-Replayed',
      'true',
    );
    expect(result).toEqual(body);
  });

  it.each([
    [
      {
        expectedMembershipVersion: 3,
        expectedRoleVersion: 0,
        roleCode: 'TEAM_LEADER',
        reason: 'review',
      },
    ],
    [
      {
        expectedMembershipVersion: 3,
        expectedRoleVersion: -1,
        roleCode: 'MEMBER',
        reason: 'review',
      },
    ],
    [
      {
        expectedMembershipVersion: 3,
        expectedRoleVersion: 0,
        roleCode: 'MEMBER',
        reason: ' ',
      },
    ],
    [
      {
        expectedMembershipVersion: 3,
        expectedRoleVersion: 0,
        roleCode: 'MEMBER',
        reason: 'review',
        extra: true,
      },
    ],
  ])(
    'rejects invalid or unknown Organization role fields: %o',
    async (body) => {
      await expect(
        controller.setOrganizationRole(
          'Bearer token',
          '__Host-csrf=csrf-token',
          'csrf-token',
          'stable-idempotency-key',
          undefined,
          organizationId,
          '951a2b3c4d5e6f7a8b9c0d1f',
          body,
          { requestId: 'validation-request-id' } as never,
          response as never,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(commands.execute).not.toHaveBeenCalled();
    },
  );

  it('authenticates before parsing membership command details', async () => {
    const authenticationError = new ForbiddenException({
      code: 'AUTH_SESSION_INVALID',
    });
    auth.getCurrentIdentity.mockRejectedValueOnce(authenticationError);
    await expect(
      controller.suspend(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        organizationId,
        'invalid-membership-id',
        {},
        response as never,
      ),
    ).rejects.toBe(authenticationError);
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it('rejects unknown list query fields', async () => {
    await expect(
      controller.listInvitations(
        'Bearer token',
        undefined,
        organizationId,
        { page: '1', roleCode: 'ADMIN' },
        response as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(commands.listInvitations).not.toHaveBeenCalled();
  });

  it.each([
    ['resume', 'RESUME', 'ACCESS_REVIEW'],
    ['remove', 'REMOVE', 'SECURITY_INCIDENT'],
  ] as const)(
    'parses %s membership lifecycle command with expectedMembershipVersion and reasonCode',
    async (methodName, commandCode, reasonCode) => {
      const membershipId = '951a2b3c4d5e6f7a8b9c0d1f';
      commands.execute.mockResolvedValueOnce({
        httpStatus: 200,
        replayed: false,
        body: {
          operationId: '851a2b3c4d5e6f7a8b9c0d1f',
          membership: {
            id: membershipId,
            organizationId,
            userId: 'a51a2b3c4d5e6f7a8b9c0d1f',
            status: commandCode === 'RESUME' ? 'ACTIVE' : 'REMOVED',
            version: 2,
          },
        },
      });
      await controller[methodName](
        'Bearer token',
        '__Host-csrf=csrf-token',
        'csrf-token',
        'stable-idempotency-key',
        'request-id',
        organizationId,
        membershipId,
        { expectedMembershipVersion: 1, reasonCode },
        response as never,
      );
      expect(commands.execute).toHaveBeenCalledWith(
        actor,
        organizationId,
        'stable-idempotency-key',
        {
          command: commandCode,
          membershipId,
          expectedMembershipVersion: 1,
          reasonCode,
        },
        'request-id',
      );
    },
  );

  it('returns organization overview and enforces strict allowlist on settings update', async () => {
    const overview = await controller.getOverview(
      'Bearer token',
      undefined,
      organizationId,
      response as never,
    );
    expect(commands.getOverview).toHaveBeenCalledWith(actor, organizationId);
    expect(overview).toMatchObject({
      organization: { id: organizationId },
    });

    await controller.updateSettings(
      'Bearer token',
      '__Host-csrf=csrf-token',
      'csrf-token',
      'request-id',
      organizationId,
      {
        expectedUpdatedAt: '2026-10-14T00:00:00.000Z',
        name: 'Continuum Updated',
        description: 'Org description',
      },
      { requestId: 'request-id' } as never,
      response as never,
    );
    expect(commands.updateSettings).toHaveBeenCalledWith(
      actor,
      organizationId,
      {
        expectedUpdatedAt: new Date('2026-10-14T00:00:00.000Z'),
        name: 'Continuum Updated',
        description: 'Org description',
        correlationId: 'request-id',
      },
    );

    await expect(
      controller.updateSettings(
        'Bearer token',
        '__Host-csrf=csrf-token',
        'csrf-token',
        'request-id',
        organizationId,
        {
          expectedUpdatedAt: '2026-10-14T00:00:00.000Z',
          name: 'Continuum Updated',
          slug: 'forbidden-slug-change',
        },
        { requestId: 'request-id' } as never,
        response as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
