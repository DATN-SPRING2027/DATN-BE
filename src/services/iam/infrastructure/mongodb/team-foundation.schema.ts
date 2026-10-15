import { Schema, Types } from 'mongoose';
import teamRules from './team-foundation.rules.cjs';

interface TeamValidationDocument {
  status?: unknown;
  archivedAt?: unknown;
  archivedBy?: unknown;
  archivedReason?: unknown;
  invalidate(path: string, message: string, value?: unknown): this;
}

interface RequiredNullableSchemaType {
  checkRequired: (value: unknown) => boolean;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export const teamFoundationSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    projectId: { type: Schema.Types.ObjectId, required: true },
    name: {
      type: String,
      required: true,
      validate: {
        validator: (value: unknown) => teamRules.isCanonicalTeamName(value),
        message:
          'name must be canonical NFC text between 1 and 200 code points',
      },
    },
    code: {
      type: String,
      required: true,
      validate: {
        validator: (value: unknown) => teamRules.isCanonicalTeamCode(value),
        message:
          'code must be canonical uppercase ASCII between 2 and 32 characters',
      },
    },
    description: {
      type: String,
      required: true,
      validate: {
        validator: (value: unknown) => teamRules.isValidTeamDescription(value),
        message:
          'description must be null or canonical text up to 2000 code points',
      },
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'ARCHIVED'],
      required: true,
    },
    version: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: (value: unknown) => teamRules.isValidTeamVersion(value),
        message: 'version must be a safe integer greater than or equal to 1',
      },
    },
    archivedAt: Date,
    archivedBy: Schema.Types.ObjectId,
    archivedReason: {
      type: String,
      validate: {
        validator: (value: unknown) =>
          value === null || teamRules.isCanonicalArchivedReason(value),
        message:
          'archivedReason must be canonical text between 1 and 500 code points',
      },
    },
  },
  {
    collection: 'teams',
    timestamps: true,
    strict: true,
  },
);

// `description` is nullable, but must be present; empty strings are valid too.
const descriptionPath = teamFoundationSchema.path(
  'description',
) as unknown as RequiredNullableSchemaType;
descriptionPath.checkRequired = (value) => value !== undefined;

teamFoundationSchema.pre('validate', function (this: TeamValidationDocument) {
  if (this.status === 'ACTIVE') {
    for (const field of [
      'archivedAt',
      'archivedBy',
      'archivedReason',
    ] as const) {
      if (this[field] !== null) {
        this.invalidate(
          field,
          'active Teams require explicit null archive metadata',
          this[field],
        );
      }
    }
  }

  if (this.status === 'ARCHIVED') {
    if (!isValidDate(this.archivedAt)) {
      this.invalidate(
        'archivedAt',
        'archived Teams require a valid archive date',
        this.archivedAt,
      );
    }
    if (!(this.archivedBy instanceof Types.ObjectId)) {
      this.invalidate(
        'archivedBy',
        'archived Teams require an archive actor',
        this.archivedBy,
      );
    }
    if (!teamRules.isCanonicalArchivedReason(this.archivedReason)) {
      this.invalidate(
        'archivedReason',
        'archived Teams require a canonical archive reason',
        this.archivedReason,
      );
    }
  }
});
