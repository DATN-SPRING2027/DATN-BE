import { Schema } from 'mongoose';

export const membershipVersion = () => ({
  type: Number,
  required: true,
  default: 1,
  min: 1,
  validate: Number.isSafeInteger,
});
export const mutationFence = () => ({
  type: Number,
  required: true,
  default: 0,
  min: 0,
  validate: Number.isSafeInteger,
});

const legacyStates = new Set(['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED']);
const invitationStates = new Set([
  'PENDING',
  'ACCEPTED',
  'CANCELLED',
  'EXPIRED',
  'SUPERSEDED',
]);
const membershipStates = new Set([
  'PENDING_INVITE',
  'ACTIVE',
  'SUSPENDED',
  'REMOVED',
]);
type InvitationProfile = { contractVersion: number };
function v2(this: InvitationProfile): boolean {
  return this.contractVersion === 2;
}

// Legacy writes retain profile1 until the separately reviewed compatibility cutover.
export const membershipInvitationSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    contractVersion: { type: Number, required: true, enum: [1, 2], default: 1 },
    version: membershipVersion(),
    membershipId: { type: Schema.Types.ObjectId, required: v2 },
    targetUserId: { type: Schema.Types.ObjectId, required: v2 },
    supersedesInvitationId: Schema.Types.ObjectId,
    roleCode: {
      type: String,
      enum: ['ADMIN', 'TEAM_LEADER', 'MEMBER'],
      required: function (this: InvitationProfile) {
        return !v2.call(this);
      },
      validate: function (this: InvitationProfile, value: unknown) {
        return !v2.call(this) || value === undefined;
      },
    },
    status: {
      type: String,
      required: true,
      validate: function (this: InvitationProfile, value: string) {
        return (v2.call(this) ? invitationStates : legacyStates).has(value);
      },
    },
    invitedBy: { type: Schema.Types.ObjectId, required: true },
    expiresAt: { type: Date, required: true },
    acceptedAt: Date,
    acceptedBy: Schema.Types.ObjectId,
    revokedAt: Date,
    revokedBy: Schema.Types.ObjectId,
  },
  { collection: 'organization_invitations', timestamps: true, strict: true },
);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const objectId = (value: unknown): boolean =>
  typeof value === 'string' && /^[a-f\d]{24}$/.test(value);
const version = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const isoDate = (value: unknown): boolean =>
  typeof value === 'string' &&
  Number.isFinite(new Date(value).getTime()) &&
  new Date(value).toISOString() === value;
function exactFields(value: Record<string, unknown>, fields: string[]) {
  return (
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}
interface OperationBinding {
  _id: unknown;
  command: string;
  membershipId: unknown;
  organizationId: unknown;
  targetUserId: unknown;
}
const resultStates: Record<string, string> = {
  INVITE: 'PENDING_INVITE',
  RESEND: 'PENDING_INVITE',
  CANCEL: 'REMOVED',
  ACCEPT: 'ACTIVE',
  SUSPEND: 'SUSPENDED',
  REMOVE: 'REMOVED',
  RESUME: 'ACTIVE',
  REINVITE: 'PENDING_INVITE',
  SET_ORGANIZATION_ROLE: 'ACTIVE',
};
function validResult(binding: OperationBinding, value: unknown): boolean {
  if (
    !record(value) ||
    !objectId(value.operationId) ||
    value.operationId !== String(binding._id)
  )
    return false;
  if (binding.command === 'RIGHTS_REVIEW') {
    const receipt = value.receipt;
    return (
      exactFields(value, ['operationId', 'receipt']) &&
      record(receipt) &&
      exactFields(receipt, [
        'id',
        'purpose',
        'targetMembershipVersion',
        'expiresAt',
      ]) &&
      objectId(receipt.id) &&
      receipt.purpose === 'RIGHTS_REVIEW' &&
      version(receipt.targetMembershipVersion) &&
      isoDate(receipt.expiresAt)
    );
  }
  if (binding.command === 'SET_ORGANIZATION_ROLE') {
    const member = value.membership;
    const role = value.role;
    return (
      exactFields(value, ['operationId', 'membership', 'role']) &&
      record(member) &&
      exactFields(member, [
        'id',
        'organizationId',
        'userId',
        'status',
        'version',
      ]) &&
      [member.id, member.organizationId, member.userId].every(objectId) &&
      member.id === String(binding.membershipId) &&
      member.organizationId === String(binding.organizationId) &&
      member.userId === String(binding.targetUserId) &&
      member.status === 'ACTIVE' &&
      version(member.version) &&
      record(role) &&
      exactFields(role, ['roleCode', 'version']) &&
      (role.roleCode === 'ADMIN' || role.roleCode === 'MEMBER') &&
      version(role.version)
    );
  }
  const member = value.membership;
  if (
    !exactFields(value, [
      'operationId',
      'membership',
      ...('invitation' in value ? ['invitation'] : []),
    ]) ||
    !record(member) ||
    !exactFields(member, [
      'id',
      'organizationId',
      'userId',
      'status',
      'version',
    ]) ||
    ![member.id, member.organizationId, member.userId].every(objectId) ||
    member.id !== String(binding.membershipId) ||
    member.organizationId !== String(binding.organizationId) ||
    member.userId !== String(binding.targetUserId) ||
    member.status !== resultStates[binding.command] ||
    typeof member.status !== 'string' ||
    !membershipStates.has(member.status) ||
    !version(member.version)
  )
    return false;
  if (!('invitation' in value)) return true;
  const invite = value.invitation;
  return (
    record(invite) &&
    exactFields(invite, ['id', 'status', 'version', 'expiresAt']) &&
    objectId(invite.id) &&
    typeof invite.status === 'string' &&
    invitationStates.has(invite.status) &&
    version(invite.version) &&
    isoDate(invite.expiresAt)
  );
}

export const membershipOperationSchema = new Schema(
  {
    actorUserId: { type: Schema.Types.ObjectId, required: true },
    organizationId: { type: Schema.Types.ObjectId, required: true },
    membershipId: { type: Schema.Types.ObjectId, required: true },
    targetUserId: { type: Schema.Types.ObjectId, required: true },
    keyHash: { type: String, required: true, match: /^[a-f\d]{64}$/ },
    fingerprintHash: { type: String, required: true, match: /^[a-f\d]{64}$/ },
    command: {
      type: String,
      required: true,
      enum: [
        'INVITE',
        'RESEND',
        'CANCEL',
        'ACCEPT',
        'SUSPEND',
        'REMOVE',
        'RESUME',
        'REINVITE',
        'RIGHTS_REVIEW',
        'SET_ORGANIZATION_ROLE',
      ],
    },
    status: { type: String, required: true, enum: ['COMMITTED'] },
    httpStatus: {
      type: Number,
      required: true,
      enum: [200, 201],
      validate: function (this: { command: string }, value: number) {
        return (
          value ===
          (['INVITE', 'RIGHTS_REVIEW'].includes(this.command) ? 201 : 200)
        );
      },
    },
    resultBody: {
      type: Schema.Types.Mixed,
      required: true,
      validate: function (this: OperationBinding, value: unknown) {
        return validResult(this, value);
      },
    },
    committedAt: { type: Date, required: true },
    expiresAt: {
      type: Date,
      required: true,
      validate: function (this: { committedAt?: Date }, value: Date) {
        return (
          this.committedAt instanceof Date &&
          value.getTime() === this.committedAt.getTime() + 86_400_000
        );
      },
    },
  },
  { collection: 'membership_operations', strict: 'throw', versionKey: false },
);
