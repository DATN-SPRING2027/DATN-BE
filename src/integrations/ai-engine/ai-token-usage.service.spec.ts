import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AiTokenUsageService } from './ai-token-usage.service';
import { AiTokenUsageController } from './ai-token-usage.controller';

const ORG_ID = '65f000000000000000000001';
const PROJ_A_ID = '65f0000000000000000000a1';
const PROJ_B_ID = '65f0000000000000000000b2';
const MEMBER_ID = '65f000000000000000000101';
const OTHER_MEMBER_ID = '65f000000000000000000102';
const LEADER_ID = '65f000000000000000000201';
const ADMIN_ID = '65f000000000000000000301';

function createMockCollection(rows: unknown[]) {
  return {
    find: jest.fn().mockImplementation((filter: Record<string, unknown>) => {
      const filtered = rows.filter((item) => {
        const doc = item as Record<string, unknown>;
        if (filter.userId instanceof Types.ObjectId) {
          if (String(doc.userId) !== filter.userId.toHexString()) return false;
        }
        if (filter.editedByUserId instanceof Types.ObjectId) {
          if (
            String(doc.editedByUserId) !== filter.editedByUserId.toHexString()
          )
            return false;
        }
        if (filter.authorUserId instanceof Types.ObjectId) {
          if (String(doc.authorUserId) !== filter.authorUserId.toHexString())
            return false;
        }
        if (filter.memberUserId instanceof Types.ObjectId) {
          if (String(doc.memberUserId) !== filter.memberUserId.toHexString())
            return false;
        }
        if (filter.ownerUserId instanceof Types.ObjectId) {
          if (String(doc.ownerUserId) !== filter.ownerUserId.toHexString())
            return false;
        }
        return true;
      });
      const chain = {
        project: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue(filtered),
      };
      return chain;
    }),
    insertOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  };
}

describe('AiTokenUsageService & AiTokenUsageController', () => {
  const now = new Date('2026-11-07T10:00:00.000Z');
  const logRows = [
    {
      organizationId: new Types.ObjectId(ORG_ID),
      projectId: new Types.ObjectId(PROJ_A_ID),
      userId: new Types.ObjectId(MEMBER_ID),
      taskKind: 'ai_chat',
      inputTokens: 1200,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      outputTokens: 400,
      calls: 2,
      occurredAt: now,
    },
    {
      organizationId: new Types.ObjectId(ORG_ID),
      projectId: new Types.ObjectId(PROJ_A_ID),
      userId: new Types.ObjectId(OTHER_MEMBER_ID),
      taskKind: 'mind_map',
      inputTokens: 5000,
      cacheReadTokens: 2000,
      cacheWriteTokens: 0,
      outputTokens: 1500,
      calls: 3,
      occurredAt: now,
    },
  ];

  const createSut = (identity: {
    id: string;
    name: string;
    organizationId: string;
    roles: string[];
  }) => {
    const auth = {
      getCurrentIdentity: jest.fn().mockResolvedValue(identity),
    };
    const projects = {
      list: jest.fn().mockResolvedValue({
        data: [
          {
            id: PROJ_A_ID,
            organizationId: ORG_ID,
            name: 'Continuum Core',
            code: 'CORE',
            status: 'ACTIVE',
            visibility: 'PRIVATE',
            leaders: [
              {
                userId: LEADER_ID,
                fullName: 'Leader One',
                email: 'leader@example.com',
              },
            ],
            memberPreviews: [
              {
                userId: MEMBER_ID,
                fullName: 'Member One',
                email: 'member1@example.com',
                roleCode: 'MEMBER',
              },
              {
                userId: OTHER_MEMBER_ID,
                fullName: 'Member Two',
                email: 'member2@example.com',
                roleCode: 'MEMBER',
              },
            ],
          },
          {
            id: PROJ_B_ID,
            organizationId: ORG_ID,
            name: 'Continuum Mobile',
            code: 'MOB',
            status: 'ACTIVE',
            visibility: 'PRIVATE',
            leaders: [],
            memberPreviews: [],
          },
        ],
        pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 },
      }),
      get: jest.fn(),
    };
    const captureDb = {
      collection: jest.fn().mockImplementation((name: string) => {
        if (name === 'ai_token_usage_logs') {
          return createMockCollection(logRows);
        }
        return createMockCollection([]);
      }),
    };
    const service = new AiTokenUsageService(
      auth as never,
      projects as never,
      undefined,
      { db: captureDb } as never,
      undefined,
    );
    return { service, auth, projects, captureDb };
  };

  it('enforces strict personal-only visibility for MEMBER even if project or organization scope is requested', async () => {
    const { service } = createSut({
      id: MEMBER_ID,
      name: 'Member One',
      organizationId: ORG_ID,
      roles: ['MEMBER'],
    });

    const result = await service.getTokenUsage(
      { authorization: 'Bearer tok' },
      { scope: 'project', projectId: PROJ_A_ID },
    );

    expect(result.effectiveScope).toBe('personal');
    expect(result.availableScopes).toEqual(['personal']);
    expect(result.ownerGroupKind).toBe('project');
    expect(result.tasks.map((t) => t.id)).toEqual([
      'ai_chat',
      'mind_map',
      'knowledge_sync',
      'note_assessment',
      'note_rewrite',
    ]);

    // Only MEMBER_ID's 1200 + 800 + 400 = 2400 tokens are returned; OTHER_MEMBER_ID's 8500 tokens are excluded
    expect(result.rows).toHaveLength(1);
    const [, , taskIdx, input, cacheRead, cacheWrite, output, calls] =
      result.rows[0];
    expect(taskIdx).toBe(0); // ai_chat
    expect(input + cacheRead + cacheWrite + output).toBe(2400);
    expect(calls).toBe(2);
    expect(JSON.stringify(result)).not.toContain('cost');
    expect(JSON.stringify(result)).not.toContain('price');
  });

  it('allows TEAM_LEADER to view project scope with member breakdown on led projects', async () => {
    const { service } = createSut({
      id: LEADER_ID,
      name: 'Leader One',
      organizationId: ORG_ID,
      roles: ['TEAM_LEADER'],
    });

    const result = await service.getTokenUsage(
      { authorization: 'Bearer tok' },
      { scope: 'project', projectId: PROJ_A_ID },
    );

    expect(result.effectiveScope).toBe('project');
    expect(result.availableScopes).toEqual(['project', 'personal']);
    expect(result.ownerGroupKind).toBe('member');
    expect(result.owners.map((o) => o.id)).toEqual(
      expect.arrayContaining([LEADER_ID, MEMBER_ID, OTHER_MEMBER_ID]),
    );
    // Both MEMBER_ID and OTHER_MEMBER_ID rows are included in project scope
    expect(result.rows).toHaveLength(2);
  });

  it('allows ADMIN to view organization scope across all projects', async () => {
    const { service } = createSut({
      id: ADMIN_ID,
      name: 'Org Manager',
      organizationId: ORG_ID,
      roles: ['ADMIN'],
    });

    const result = await service.getTokenUsage(
      { authorization: 'Bearer tok' },
      {},
    );

    expect(result.effectiveScope).toBe('organization');
    expect(result.availableScopes).toEqual([
      'organization',
      'project',
      'personal',
    ]);
    expect(result.ownerGroupKind).toBe('project');
    expect(result.rows).toHaveLength(2);
  });

  it('rejects mismatched organization header or unexpected query params', async () => {
    const { service } = createSut({
      id: MEMBER_ID,
      name: 'Member One',
      organizationId: ORG_ID,
      roles: ['MEMBER'],
    });
    await expect(
      service.getTokenUsage(
        {
          authorization: 'Bearer tok',
          organizationId: '65f000000000000000000999',
        },
        {},
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const controller = new AiTokenUsageController(service);
    await expect(
      controller.getTokenUsage(
        { headers: {} } as never,
        { setHeader: jest.fn() } as never,
        { unknownParam: '1' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
