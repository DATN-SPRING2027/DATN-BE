import { Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { SERVICE_DATABASES } from '../../../../common/mongodb/database-names';
import type { ChatOrgMembershipChecker } from '../../application/chat-dm-assistant.types';
import { CHAT_PERSISTENCE } from '../persistence';

/**
 * Read-only fail-closed IAM active organization & account verifier for background
 * Chat DM assistant workers. Uses the existing Chat cluster connection via
 * `connection.useDb(SERVICE_DATABASES.iam, { useCache: true })` so ChatModule
 * remains completely decoupled from IamModule (standalone microservice safe).
 */
@Injectable()
export class MongoChatOrgMembershipChecker implements ChatOrgMembershipChecker {
  constructor(
    @Optional()
    @InjectConnection(CHAT_PERSISTENCE.databaseName)
    private readonly chatConnection?: Connection,
  ) {}

  async isActiveOrganizationMember(
    organizationId: string,
    userId: string,
  ): Promise<boolean> {
    if (
      !Types.ObjectId.isValid(organizationId) ||
      !Types.ObjectId.isValid(userId)
    ) {
      return false;
    }
    if (
      !this.chatConnection ||
      typeof this.chatConnection.useDb !== 'function'
    ) {
      throw new Error(
        'IAM membership verification database connection is unavailable.',
      );
    }
    const iamDb = this.chatConnection.useDb(SERVICE_DATABASES.iam, {
      useCache: true,
    }).db;
    if (!iamDb) {
      throw new Error('IAM database handle is unavailable.');
    }

    const orgObjectId = new Types.ObjectId(organizationId);
    const userObjectId = new Types.ObjectId(userId);
    const [membership, user] = await Promise.all([
      iamDb.collection('organization_memberships').findOne(
        {
          organizationId: orgObjectId,
          userId: userObjectId,
          status: 'ACTIVE',
        },
        { projection: { _id: 1 } },
      ),
      iamDb.collection('users').findOne(
        {
          _id: userObjectId,
          status: 'ACTIVE',
        },
        { projection: { _id: 1 } },
      ),
    ]);

    return Boolean(membership && user);
  }
}
