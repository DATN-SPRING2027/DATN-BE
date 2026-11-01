import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { CAPTURE_PERSISTENCE } from '../infrastructure/persistence';
import {
  ProjectReportRosterService,
  type ReportingProjectMembers,
} from '../../iam/application/projects/project-report-roster.service';
import { NotificationService } from '../../notification/notification.service';
import { WorkReportReminderMailer } from './work-report-reminder.mailer';

const LEAD_TIMES = [60, 120, 1440, 2880];

@Injectable()
export class WorkReportReminderService {
  private readonly logger = new Logger(WorkReportReminderService.name);
  constructor(
    @Optional()
    @InjectConnection(CAPTURE_PERSISTENCE.databaseName)
    private readonly connection: Connection | undefined,
    private readonly roster: ProjectReportRosterService,
    private readonly notifications: NotificationService,
    private readonly mailer: WorkReportReminderMailer,
  ) {}

  async sweep(
    rosters: ReportingProjectMembers[],
    now = new Date(),
  ): Promise<void> {
    const scanStartedAt = Date.now();
    const db = this.connection?.db;
    if (!db) return;
    // IAM's roster excludes inactive project/org memberships and distinguishes tiers.
    for (const project of rosters) {
      try {
        const filter = {
          organizationId: new Types.ObjectId(project.organizationId),
          projectId: new Types.ObjectId(project.projectId),
        };
        const settings = await db.collection('work_report_settings').findOne(
          {
            ...filter,
            $or: [
              { memberReminderLeadMinutes: { $in: LEAD_TIMES } },
              { leaderReminderLeadMinutes: { $in: LEAD_TIMES } },
            ],
          },
          { sort: { effectiveAt: 1, _id: 1 } },
        );
        if (!settings) continue;
        for (const scope of ['MEMBER', 'LEADER'] as const) {
          const lead = settings[
            scope === 'LEADER'
              ? 'leaderReminderLeadMinutes'
              : 'memberReminderLeadMinutes'
          ] as number;
          if (!LEAD_TIMES.includes(lead)) continue;
          const members =
            scope === 'LEADER' ? (project.leaders ?? []) : project.members;
          if (!members.length) continue;
          const reports = db.collection('work_reports');
          // Cursor iteration avoids starving later reports behind a fixed batch limit.
          const cursor = reports
            .find({
              ...filter,
              ...(scope === 'LEADER'
                ? { reportScope: 'LEADER' }
                : {
                    $or: [
                      { reportScope: 'MEMBER' },
                      { reportScope: { $exists: false } },
                    ],
                  }),
              memberUserId: {
                $in: members.map((member) => new Types.ObjectId(member.userId)),
              },
              status: { $in: ['DRAFT', 'CHANGES_REQUESTED'] },
              dueAt: {
                $gt: now,
                $lte: new Date(now.getTime() + lead * 60_000),
              },
            })
            .sort({ dueAt: 1, _id: 1 });
          for await (const report of cursor) {
            try {
              const dueAt = report.dueAt as Date;
              if (
                report.reminderEmailSentAt &&
                report.reminderEmailDueAt instanceof Date &&
                report.reminderEmailDueAt.getTime() === dueAt.getTime()
              )
                continue;
              const claimTime = new Date(
                now.getTime() + Date.now() - scanStartedAt,
              );
              if (dueAt <= claimTime) continue;
              const eventKey = `work-report-reminder:${String(report._id)}:${dueAt.getTime()}`;
              const email = await this.roster.activeReportRecipientEmail(
                project.organizationId,
                project.projectId,
                String(report.memberUserId),
              );
              if (!email) continue;
              const remainingMinutes = Math.max(
                1,
                Math.ceil((dueAt.getTime() - now.getTime()) / 60_000),
              );
              await this.notifications.emit({
                type: 'WORK_REPORT_DEADLINE_APPROACHING',
                actorId: null,
                recipients: [String(report.memberUserId)],
                title: 'Work Report due soon',
                message: `Your Work Report is due in ${remainingMinutes >= 1440 ? `${Math.ceil(remainingMinutes / 1440)} day(s)` : `${Math.ceil(remainingMinutes / 60)} hour(s)`} (${dueAt.toISOString()}). Please complete and submit it.`,
                organizationId: project.organizationId,
                projectId: project.projectId,
                target: {
                  kind: 'PROJECT',
                  reportId: String(report._id),
                  url: `/projects/${project.projectId}/work-reports`,
                  organizationId: project.organizationId,
                  projectId: project.projectId,
                },
                eventKey,
              });
              const leaseToken = randomUUID();
              const claim = await reports.updateOne(
                {
                  _id: report._id,
                  status: { $in: ['DRAFT', 'CHANGES_REQUESTED'] },
                  dueAt,
                  $and: [
                    {
                      $or: [
                        { reminderEmailDueAt: { $ne: dueAt } },
                        { reminderEmailSentAt: null },
                      ],
                    },
                    {
                      $or: [
                        { reminderEmailLeaseUntil: null },
                        { reminderEmailLeaseUntil: { $lte: claimTime } },
                      ],
                    },
                  ],
                },
                {
                  $set: {
                    reminderEmailLeaseUntil: new Date(
                      claimTime.getTime() + 300_000,
                    ),
                    reminderEmailLeaseToken: leaseToken,
                  },
                },
              );
              if (!claim.modifiedCount) continue;
              // A failed send keeps a five-minute retry delay; a lease prevents concurrent replicas sending.
              await this.mailer.send(
                email,
                project.projectId,
                dueAt,
                eventKey,
                project.projectName,
              );
              await reports.updateOne(
                { _id: report._id, reminderEmailLeaseToken: leaseToken },
                {
                  $set: {
                    reminderEmailDueAt: dueAt,
                    reminderEmailSentAt: new Date(),
                  },
                  $unset: {
                    reminderEmailLeaseUntil: '',
                    reminderEmailLeaseToken: '',
                  },
                },
              );
            } catch {
              this.logger.error(
                'Work Report reminder delivery failed; it will be retried on a later scan.',
              );
            }
          }
        }
      } catch {
        this.logger.error(
          'Unable to scan Work Report reminders for a project.',
        );
      }
    }
  }
}
