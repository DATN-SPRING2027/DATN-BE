import { WorkReportOverdueScheduler } from './work-report-overdue.scheduler';

describe('Work Report scheduler', () => {
  it('still marks existing reports overdue when the IAM roster is unavailable', async () => {
    const workNotes = {
      ensureScheduledReportObligations: jest.fn(),
      sweepOverdueReports: jest.fn().mockResolvedValue(undefined),
    };
    const roster = {
      activeProjects() {
        return (async function* () {
          yield await Promise.reject(new Error('IAM unavailable'));
        })();
      },
    };
    const scheduler = new WorkReportOverdueScheduler(
      workNotes as never,
      roster,
    );

    await (scheduler as unknown as { sweep: () => Promise<void> }).sweep();

    expect(workNotes.sweepOverdueReports).toHaveBeenCalledTimes(1);
  });

  it('creates obligations for active member rosters before the overdue sweep', async () => {
    const project = {
      organizationId: '111111111111111111111111',
      projectId: '222222222222222222222222',
      projectCreatedBy: '333333333333333333333333',
      members: [
        {
          userId: '444444444444444444444444',
          joinedAt: '2026-10-20T12:00:00.000Z',
        },
      ],
    };
    const calls: string[] = [];
    const workNotes = {
      ensureScheduledReportObligations: jest.fn(() => {
        calls.push('obligations');
        return Promise.resolve();
      }),
      sweepOverdueReports: jest.fn(() => {
        calls.push('overdue');
        return Promise.resolve();
      }),
    };
    const roster = {
      activeProjects() {
        return (async function* () {
          yield await Promise.resolve(project);
        })();
      },
    };
    const scheduler = new WorkReportOverdueScheduler(
      workNotes as never,
      roster,
    );

    await (scheduler as unknown as { sweep: () => Promise<void> }).sweep();

    expect(workNotes.ensureScheduledReportObligations).toHaveBeenCalledWith(
      project,
    );
    expect(calls).toEqual(['obligations', 'overdue']);
  });
});
