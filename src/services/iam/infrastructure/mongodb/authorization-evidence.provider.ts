import { Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import type {
  AuthorizationEvidenceProvider,
  ProjectCreateEvidence,
} from '../../application/authorization/authorization-evidence.provider';
import { IAM_PERSISTENCE } from '../persistence';

interface MembershipDocument {
  userId: Types.ObjectId;
  organizationId: Types.ObjectId;
  status: string;
}

const modelName = (collection: string): string =>
  `${IAM_PERSISTENCE.databaseName}_${collection}`;
const validId = (value: string): boolean => /^[a-f\d]{24}$/i.test(value);

@Injectable()
export class MongoAuthorizationEvidenceProvider implements AuthorizationEvidenceProvider {
  constructor(
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
  ) {}

  async loadProjectCreate(
    userId: string,
    organizationId: string,
  ): Promise<ProjectCreateEvidence | null> {
    if (!validId(userId) || !validId(organizationId)) return null;
    const userObjectId = new Types.ObjectId(userId);
    const organizationObjectId = new Types.ObjectId(organizationId);
    const membership = await this.model<MembershipDocument>(
      'organization_memberships',
    )
      .findOne(
        {
          userId: userObjectId,
          organizationId: organizationObjectId,
          status: 'ACTIVE',
        },
        { userId: 1, organizationId: 1, status: 1 },
      )
      .lean()
      .exec();
    if (!membership) {
      return {
        membership: null,
        explicitDeny: 'CLEAR',
      };
    }

    return {
      membership: {
        userId: String(membership.userId),
        organizationId: String(membership.organizationId),
        status: membership.status,
      },
      // Membership has no DENY field; no current project.create source
      // supports explicit deny.
      explicitDeny: 'CLEAR',
    };
  }

  private model<T>(collection: string): Model<T> {
    const model = this.connection?.models[modelName(collection)] as
      Model<T> | undefined;
    if (!model)
      throw new Error(`Authorization evidence unavailable: ${collection}`);
    return model;
  }
}
