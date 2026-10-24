import { WorkReportOverdueScheduler } from './work-report-overdue.scheduler';

describe('Work Report scheduler', () => {
  it('skips the overdue sweep when the IAM roster is unavailable so inactive members are not marked overdue', async () => {
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

    expect(workNotes.sweepOverdueReports).not.toHaveBeenCalled();
  });

  it('continues processing remaining projects and preserves active rosters when obligation creation fails for one project', async () => {
    const projectA = {
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
    const projectB = {
      organizationId: '111111111111111111111111',
      projectId: '555555555555555555555555',
      projectCreatedBy: '333333333333333333333333',
      members: [
        {
          userId: '666666666666666666666666',
          joinedAt: '2026-10-20T12:00:00.000Z',
        },
      ],
    };
    const workNotes = {
      ensureScheduledReportObligations: jest
        .fn()
        .mockRejectedValueOnce(new Error('Project A failed'))
        .mockResolvedValueOnce(undefined),
      sweepOverdueReports: jest.fn().mockResolvedValue(undefined),
    };
    const roster = {
      activeProjects() {
        return (async function* () {
          yield await Promise.resolve(projectA);
          yield await Promise.resolve(projectB);
        })();
      },
    };
    const scheduler = new WorkReportOverdueScheduler(
      workNotes as never,
      roster,
    );

    await (scheduler as unknown as { sweep: () => Promise<void> }).sweep();

    expect(workNotes.ensureScheduledReportObligations).toHaveBeenCalledTimes(2);
    expect(workNotes.ensureScheduledReportObligations).toHaveBeenNthCalledWith(
      1,
      projectA,
    );
    expect(workNotes.ensureScheduledReportObligations).toHaveBeenNthCalledWith(
      2,
      projectB,
    );
    expect(workNotes.sweepOverdueReports).toHaveBeenCalledWith([
      projectA,
      projectB,
    ]);
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
    expect(workNotes.sweepOverdueReports).toHaveBeenCalledWith([project]);
    expect(calls).toEqual(['obligations', 'overdue']);
  });
});
