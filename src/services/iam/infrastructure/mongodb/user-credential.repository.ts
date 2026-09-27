import { Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection, Model, Types } from 'mongoose';
import { IAM_PERSISTENCE } from '../persistence';

interface UserCredentialDocument {
  _id: Types.ObjectId;
  email: string;
  passwordHash: string;
}

export interface StoredUserCredential {
  userId: string;
  passwordHash: string;
}

export class UserCredentialLookupUnavailableError extends Error {
  constructor(reason: 'CONNECTION_UNAVAILABLE' | 'USER_MODEL_UNAVAILABLE') {
    super(`User credential lookup unavailable: ${reason}`);
    this.name = UserCredentialLookupUnavailableError.name;
  }
}

const usersCollection = IAM_PERSISTENCE.collections.find(
  (collection) => collection.name === 'users',
);
if (!usersCollection) {
  throw new Error('IAM persistence definition does not include users');
}
const USER_MODEL_NAME = `${IAM_PERSISTENCE.databaseName}_${usersCollection.name}`;

@Injectable()
export class UserCredentialRepository {
  constructor(
    @Optional() @InjectConnection() private readonly connection?: Connection,
  ) {}

  async findByEmail(email: string): Promise<StoredUserCredential | null> {
    if (!this.connection) {
      throw new UserCredentialLookupUnavailableError('CONNECTION_UNAVAILABLE');
    }

    const userModel = this.connection.models[USER_MODEL_NAME] as
      Model<UserCredentialDocument> | undefined;
    if (!userModel) {
      throw new UserCredentialLookupUnavailableError('USER_MODEL_UNAVAILABLE');
    }

    // Match the lowercase/trim persistence setters without adding account
    // eligibility or authentication behavior to this repository.
    const normalizedEmail = email.trim().toLowerCase();
    const user = await userModel
      .findOne({ email: normalizedEmail }, { _id: 1, passwordHash: 1 })
      .lean()
      .exec();

    if (!user) return null;

    return {
      userId: String(user._id),
      passwordHash: user.passwordHash,
    };
  }
}
