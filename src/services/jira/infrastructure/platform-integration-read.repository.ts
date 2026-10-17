import {
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Connection, Document } from 'mongoose';
import { SERVICE_DATABASES } from '../../../common/mongodb/database-names';
import type {
  PlatformIntegrationListInput,
  PlatformIntegrationPage,
  PlatformIntegrationReadRepository,
  PlatformIntegrationSummary,
} from '../application/platform-integration-read.repository';

interface JiraConnectionDocument extends Document {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  status: 'CONNECTED' | 'EXPIRED' | 'REVOKED';
  lastSyncAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class MongoPlatformIntegrationReadRepository implements PlatformIntegrationReadRepository {
  constructor(
    @Optional()
    @InjectConnection(SERVICE_DATABASES.jira)
    private readonly connection?: Connection,
  ) {}

  async list(
    input: PlatformIntegrationListInput,
  ): Promise<PlatformIntegrationPage> {
    const collection = this.collection();
    const filter = this.createFilter(input);
    const [rows, totalItems] = await Promise.all([
      collection
        .find(filter, {
          projection: {
            _id: 1,
            organizationId: 1,
            projectId: 1,
            status: 1,
            lastSyncAt: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        })
        .sort({ updatedAt: -1, _id: -1 })
        .skip((input.page - 1) * input.pageSize)
        .limit(input.pageSize)
        .toArray(),
      collection.countDocuments(filter),
    ]);
    const ids = rows.map((row) => row._id);
    const failures = await this.readLatestFailures(ids);
    return {
      data: rows.map((row) =>
        this.project(row, failures.get(String(row._id)) ?? null),
      ),
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / input.pageSize),
      },
    };
  }

  async findById(id: string): Promise<PlatformIntegrationSummary | null> {
    const connection = this.connectionOrUnavailable();
    const database = connection.useDb(SERVICE_DATABASES.jira, {
      useCache: true,
    });
    const row = await database
      .collection<JiraConnectionDocument>('jira_connections')
      .findOne(
        { _id: new Types.ObjectId(id) },
        {
          projection: {
            _id: 1,
            organizationId: 1,
            projectId: 1,
            status: 1,
            lastSyncAt: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      );
    if (!row) return null;
    const failures = await this.readLatestFailures([row._id]);
    return this.project(row, failures.get(String(row._id)) ?? null);
  }

  private collection() {
    return this.connectionOrUnavailable()
      .useDb(SERVICE_DATABASES.jira, { useCache: true })
      .collection<JiraConnectionDocument>('jira_connections');
  }

  private connectionOrUnavailable(): Connection {
    if (!this.connection) {
      throw new ServiceUnavailableException(
        'Jira integration data unavailable',
      );
    }
    return this.connection;
  }

  private createFilter(input: PlatformIntegrationListInput) {
    return {
      ...(input.organizationId
        ? { organizationId: new Types.ObjectId(input.organizationId) }
        : {}),
      ...(input.projectId
        ? { projectId: new Types.ObjectId(input.projectId) }
        : {}),
      ...(input.status ? { status: input.status } : {}),
    };
  }

  private async readLatestFailures(
    connectionIds: Types.ObjectId[],
  ): Promise<Map<string, Date>> {
    if (connectionIds.length === 0) return new Map();
    const database = this.connectionOrUnavailable().useDb(
      SERVICE_DATABASES.jira,
      { useCache: true },
    );
    const rows = await database
      .collection('jira_sync_jobs')
      .aggregate<{
        _id: Types.ObjectId;
        failedAt?: Date;
      }>([
        {
          $match: {
            connectionId: { $in: connectionIds },
            status: 'FAILED',
          },
        },
        { $sort: { completedAt: -1, updatedAt: -1, _id: -1 } },
        {
          $group: {
            _id: '$connectionId',
            failedAt: { $first: { $ifNull: ['$completedAt', '$updatedAt'] } },
          },
        },
        { $project: { _id: 1, failedAt: 1 } },
      ])
      .toArray();
    return new Map(
      rows.flatMap((row) =>
        row.failedAt instanceof Date && Number.isFinite(row.failedAt.getTime())
          ? [[String(row._id), row.failedAt] as const]
          : [],
      ),
    );
  }

  private project(
    row: JiraConnectionDocument,
    failedAt: Date | null,
  ): PlatformIntegrationSummary {
    if (
      !row._id ||
      !row.organizationId ||
      !row.projectId ||
      !['CONNECTED', 'EXPIRED', 'REVOKED'].includes(row.status) ||
      !(row.createdAt instanceof Date) ||
      !(row.updatedAt instanceof Date)
    ) {
      throw new ServiceUnavailableException('Jira integration data invalid');
    }
    return {
      id: String(row._id),
      provider: 'JIRA',
      organizationId: String(row.organizationId),
      projectId: String(row.projectId),
      status: row.status,
      lastSyncAt: safeIsoDate(row.lastSyncAt),
      lastFailureAt: failedAt?.toISOString() ?? null,
      lastFailureSummary: failedAt
        ? 'A Jira sync failed. Raw failure details are withheld.'
        : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function safeIsoDate(value: unknown): string | null {
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString()
    : null;
}
