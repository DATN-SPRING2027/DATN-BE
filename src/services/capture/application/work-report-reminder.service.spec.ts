import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Types, type Connection } from 'mongoose';
import { WorkReportReminderService } from './work-report-reminder.service';
import type {
  ProjectReportRosterService,
  ReportingProjectMembers,
} from '../../iam/application/projects/project-report-roster.service';
import type { NotificationService } from '../../notification/notification.service';
import type { WorkReportReminderMailer } from './work-report-reminder.mailer';

describe('scheduled Work Report reminders', () => {
  jest.setTimeout(120_000);
  let mongo: MongoMemoryServer;
  let connection: Connection;
  let service: WorkReportReminderService;
  const organizationId = new Types.ObjectId();
  const projectId = new Types.ObjectId();
  const memberId = new Types.ObjectId();
  const leaderId = new Types.ObjectId();
  const now = new Date('2026-10-30T08:00:00Z');
  const dueAt = new Date(now.getTime() + 60 * 60_000);
  const roster: ReportingProjectMembers = {
    organizationId: String(organizationId),
    projectId: String(projectId),
    projectCreatedBy: String(leaderId),
    members: [{ userId: String(memberId), joinedAt: now.toISOString() }],
    leaders: [{ userId: String(leaderId), joinedAt: now.toISOString() }],
  };
  const address = jest.fn();
  const emit = jest.fn();
  const send = jest.fn();
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ binary: { version: '7.0.24' } });
    connection = mongoose.createConnection(mongo.getUri(), {
      dbName: 'reminder_test',
    });
    await connection.asPromise();
  });
  afterAll(async () => {
    await connection?.close();
    await mongo?.stop();
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    address.mockResolvedValue('member@example.test');
    emit.mockResolvedValue([]);
    send.mockResolvedValue(undefined);
    await connection.db!.dropDatabase();
    await connection.db!.collection('work_report_settings').insertOne({
      organizationId,
      projectId,
      reportScope: 'MEMBER',
      effectiveAt: now,
      memberReminderLeadMinutes: 60,
      leaderReminderLeadMinutes: null,
    });
    service = new WorkReportReminderService(
      connection,
      {
        activeReportRecipientEmail: address,
      } as unknown as ProjectReportRosterService,
      { emit } as unknown as NotificationService,
      { send } as unknown as WorkReportReminderMailer,
    );
  });
  async function report(overrides: Record<string, unknown> = {}) {
    const row = {
      organizationId,
      projectId,
      memberUserId: memberId,
      reportScope: 'MEMBER',
      status: 'DRAFT',
      dueAt,
      ...overrides,
    };
    return (await connection.db!.collection('work_reports').insertOne(row))
      .insertedId;
  }
  it('sends email without a browser, deduplicates scans and uses stable notification keys', async () => {
    const id = await report();
    await service.sweep([roster], now);
    await service.sweep([roster], now);
    expect(send).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'WORK_REPORT_DEADLINE_APPROACHING',
        recipients: [String(memberId)],
        eventKey: `work-report-reminder:${String(id)}:${dueAt.getTime()}`,
      }),
    );
    const row = await connection
      .db!.collection('work_reports')
      .findOne({ _id: id });
    expect(row?.reminderEmailSentAt).toBeInstanceOf(Date);
  });
  it('filters submitted, expired, distant, foreign-org, removed and disabled tier reports', async () => {
    await report({ status: 'PENDING_REVIEW' });
    await report({ status: 'APPROVED' });
    await report({ dueAt: now });
    await report({ dueAt: new Date(dueAt.getTime() + 1) });
    await report({ organizationId: new Types.ObjectId() });
    await report({ memberUserId: new Types.ObjectId() });
    await report({ reportScope: 'LEADER', memberUserId: leaderId });
    await service.sweep([roster], now);
    expect(send).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
  it('handles per-tier days configuration and changes-requested reports', async () => {
    await connection.db!.collection('work_report_settings').updateMany(
      {},
      {
        $set: {
          memberReminderLeadMinutes: null,
          leaderReminderLeadMinutes: 2880,
        },
      },
    );
    await report();
    await report({
      reportScope: 'LEADER',
      memberUserId: leaderId,
      status: 'CHANGES_REQUESTED',
      dueAt: new Date(now.getTime() + 2 * 86_400_000),
    });
    await service.sweep([roster], now);
    expect(send).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ recipients: [String(leaderId)] }),
    );
  });
  it('fails closed if IAM can no longer confirm an active delivery recipient', async () => {
    await report();
    address.mockResolvedValue(null);
    await service.sweep([roster], now);
    expect(send).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
  it('allows one replica to claim email and retries failed SMTP delivery after the lease expires', async () => {
    await report();
    send.mockRejectedValueOnce(new Error('SMTP unavailable'));
    await Promise.all([
      service.sweep([roster], now),
      service.sweep([roster], now),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    await service.sweep([roster], new Date(now.getTime() + 299_000));
    expect(send).toHaveBeenCalledTimes(1);
    await service.sweep([roster], new Date(now.getTime() + 301_000));
    expect(send).toHaveBeenCalledTimes(2);
    await service.sweep([roster], new Date(now.getTime() + 600_000));
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('retries notification persistence before sending email', async () => {
    await report();
    emit.mockRejectedValueOnce(new Error('notification unavailable'));
    await service.sweep([roster], now);
    expect(send).not.toHaveBeenCalled();
    await service.sweep([roster], now);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
