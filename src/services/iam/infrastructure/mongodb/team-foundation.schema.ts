import { Schema } from 'mongoose';
import {
  isCanonicalArchivedReason,
  isCanonicalTeamCode,
  isCanonicalTeamName,
  isValidTeamDescription,
  isValidTeamVersion,
  normalizeArchivedReason,
  normalizeTeamCode,
  normalizeTeamName,
} from './team-foundation.rules.cjs';

function text(value: unknown): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new TypeError('Team text must be a string or null');
}
type ArchiveProfile = {
  status: string;
  description?: string | null;
  archivedAt?: Date | null;
  archivedBy?: unknown;
  archivedReason?: string | null;
};

// No lifecycle/version defaults: loading legacy data must not confer ACTIVE.
// These document validators do not replace future command authorization/CAS.
export const teamFoundationSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    projectId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    name: {
      type: String,
      required: true,
      set: (value: unknown) => {
        const string = text(value);
        return string === null ? null : normalizeTeamName(string);
      },
      validate: isCanonicalTeamName,
    },
    code: {
      type: String,
      required: true,
      immutable: true,
      set: (value: unknown) => {
        const string = text(value);
        return string === null ? null : normalizeTeamCode(string);
      },
      validate: isCanonicalTeamCode,
    },
    description: {
      type: String,
      set: text,
      required: function (this: ArchiveProfile & { description?: unknown }) {
        return this.description === undefined;
      },
      validate: isValidTeamDescription,
    },
    status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], required: true },
    version: {
      type: Number,
      cast: false,
      required: true,
      validate: isValidTeamVersion,
    },
    archivedAt: {
      type: Date,
      required: function (this: ArchiveProfile) {
        return this.status === 'ARCHIVED' || this.archivedAt !== null;
      },
      validate: function (this: ArchiveProfile, value: Date | null) {
        return this.status === 'ARCHIVED'
          ? value instanceof Date
          : value === null;
      },
    },
    archivedBy: {
      type: Schema.Types.ObjectId,
      required: function (this: ArchiveProfile) {
        return this.status === 'ARCHIVED' || this.archivedBy !== null;
      },
      validate: function (this: ArchiveProfile, value: unknown) {
        return this.status === 'ARCHIVED' ? value != null : value === null;
      },
    },
    archivedReason: {
      type: String,
      set: (value: unknown) => {
        const string = text(value);
        return string === null ? null : normalizeArchivedReason(string);
      },
      required: function (this: ArchiveProfile) {
        return this.status === 'ARCHIVED' || this.archivedReason !== null;
      },
      validate: function (this: ArchiveProfile, value: string | null) {
        return this.status === 'ARCHIVED'
          ? isCanonicalArchivedReason(value)
          : value === null;
      },
    },
  },
  { collection: 'teams', timestamps: true, strict: 'throw' },
);
