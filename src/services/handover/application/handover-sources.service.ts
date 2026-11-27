import { Injectable } from '@nestjs/common';
import {
  HandoverCaptureSourceService,
  type EvaluatedHandoverSource,
  type HandoverSourceViewer,
} from '../../capture/application/handover-capture-source.service';
import { HandoverLifecycleSourceService } from '../../lifecycle/application/handover-lifecycle-source.service';
import { parseSourceVersionNumber, sourceRefKey } from './handover.domain';
import type { DepartingMemberSourceDto, SourceRefDto } from './handover.types';

@Injectable()
export class HandoverSourcesService {
  constructor(
    private readonly captureSourceService: HandoverCaptureSourceService,
    private readonly lifecycleSourceService: HandoverLifecycleSourceService,
  ) {}

  async evaluateSourceRef(
    viewer: HandoverSourceViewer,
    ref: SourceRefDto,
  ): Promise<EvaluatedHandoverSource> {
    const verNum = parseSourceVersionNumber(ref.version);
    if (verNum === null) {
      return {
        kind: ref.kind,
        id: ref.id.toLowerCase(),
        version: 0,
        exists: false,
        eligible: false,
        readable: false,
        isCurrent: false,
        currentVersion: null,
        title: '',
        excerpts: [],
      };
    }

    if (ref.kind === 'KNOWLEDGE_OBJECT') {
      return this.lifecycleSourceService.evaluateSource(viewer, {
        kind: 'KNOWLEDGE_OBJECT',
        id: ref.id,
        version: verNum,
      });
    }

    return this.captureSourceService.evaluateSource(viewer, {
      kind: ref.kind,
      id: ref.id,
      version: verNum,
    });
  }

  async evaluateSourceRefsMap(
    viewer: HandoverSourceViewer,
    refs: readonly SourceRefDto[],
  ): Promise<Map<string, EvaluatedHandoverSource>> {
    const [result] = await this.evaluateSourceRefsMapForViewers([viewer], refs);
    return result ?? new Map<string, EvaluatedHandoverSource>();
  }

  async evaluateSourceRefsMapForViewers(
    viewers: readonly HandoverSourceViewer[],
    refs: readonly SourceRefDto[],
  ): Promise<Array<Map<string, EvaluatedHandoverSource>>> {
    if (viewers.length === 0) return [];
    const uniqueByKey = new Map<string, SourceRefDto>();
    for (const ref of refs) {
      uniqueByKey.set(sourceRefKey(ref), ref);
    }
    if (uniqueByKey.size === 0) {
      return viewers.map(() => new Map<string, EvaluatedHandoverSource>());
    }

    const viewerKey = (v: HandoverSourceViewer) =>
      `${v.organizationId.toLowerCase()}:${v.projectId.toLowerCase()}:${v.userId.toLowerCase()}:${v.isProjectMember ? 1 : 0}:${v.isProjectLeader ? 1 : 0}`;

    const uniqueViewers: HandoverSourceViewer[] = [];
    const viewerIndexByKey = new Map<string, number>();
    const inputToUniqueIndex: number[] = [];
    for (const viewer of viewers) {
      const key = viewerKey(viewer);
      let idx = viewerIndexByKey.get(key);
      if (idx === undefined) {
        idx = uniqueViewers.length;
        viewerIndexByKey.set(key, idx);
        uniqueViewers.push(viewer);
      }
      inputToUniqueIndex.push(idx);
    }

    const uniqueMaps = uniqueViewers.map(
      () => new Map<string, EvaluatedHandoverSource>(),
    );

    const lifecycleEntries: Array<{
      key: string;
      ref: { kind: 'KNOWLEDGE_OBJECT'; id: string; version: number };
    }> = [];
    const captureEntries: Array<{
      key: string;
      ref: {
        kind: 'TASK_NOTE' | 'PROJECT_DOCUMENT' | 'WORK_REPORT';
        id: string;
        version: number;
      };
    }> = [];

    for (const [key, ref] of uniqueByKey.entries()) {
      const verNum = parseSourceVersionNumber(ref.version);
      if (verNum === null) {
        const invalid: EvaluatedHandoverSource = {
          kind: ref.kind,
          id: ref.id.toLowerCase(),
          version: 0,
          exists: false,
          eligible: false,
          readable: false,
          isCurrent: false,
          currentVersion: null,
          title: '',
          excerpts: [],
        };
        for (const map of uniqueMaps) map.set(key, invalid);
        continue;
      }
      if (ref.kind === 'KNOWLEDGE_OBJECT') {
        lifecycleEntries.push({
          key,
          ref: { kind: 'KNOWLEDGE_OBJECT', id: ref.id, version: verNum },
        });
      } else {
        captureEntries.push({
          key,
          ref: { kind: ref.kind, id: ref.id, version: verNum },
        });
      }
    }

    const captureSvc = this
      .captureSourceService as HandoverCaptureSourceService & {
      evaluateSourcesBatch?: (
        viewer: HandoverSourceViewer,
        refs: ReadonlyArray<{
          kind: 'TASK_NOTE' | 'PROJECT_DOCUMENT' | 'WORK_REPORT';
          id: string;
          version: number;
        }>,
      ) => Promise<EvaluatedHandoverSource[]>;
      evaluateSourcesBatchForViewers?: (
        viewers: readonly HandoverSourceViewer[],
        refs: ReadonlyArray<{
          kind: 'TASK_NOTE' | 'PROJECT_DOCUMENT' | 'WORK_REPORT';
          id: string;
          version: number;
        }>,
      ) => Promise<EvaluatedHandoverSource[][]>;
    };

    const evaluateLifecycle = async (): Promise<void> => {
      if (lifecycleEntries.length === 0) return;
      const lifecycleRefs = lifecycleEntries.map((e) => e.ref);
      let matrix: EvaluatedHandoverSource[][];
      if (
        typeof this.lifecycleSourceService.evaluateSourcesBatchForViewers ===
        'function'
      ) {
        matrix =
          await this.lifecycleSourceService.evaluateSourcesBatchForViewers(
            uniqueViewers,
            lifecycleRefs,
          );
      } else if (
        typeof this.lifecycleSourceService.evaluateSourcesBatch === 'function'
      ) {
        matrix = await Promise.all(
          uniqueViewers.map((viewer) =>
            this.lifecycleSourceService.evaluateSourcesBatch(
              viewer,
              lifecycleRefs,
            ),
          ),
        );
      } else {
        matrix = await Promise.all(
          uniqueViewers.map((viewer) =>
            Promise.all(
              lifecycleRefs.map((ref) =>
                this.lifecycleSourceService.evaluateSource(viewer, ref),
              ),
            ),
          ),
        );
      }
      for (let vIdx = 0; vIdx < uniqueViewers.length; vIdx += 1) {
        const row = matrix[vIdx] ?? [];
        for (let rIdx = 0; rIdx < lifecycleEntries.length; rIdx += 1) {
          if (row[rIdx]) {
            uniqueMaps[vIdx].set(lifecycleEntries[rIdx].key, row[rIdx]);
          }
        }
      }
    };

    const evaluateCapture = async (): Promise<void> => {
      if (captureEntries.length === 0) return;
      const captureRefs = captureEntries.map((e) => e.ref);
      let matrix: EvaluatedHandoverSource[][];
      if (typeof captureSvc.evaluateSourcesBatchForViewers === 'function') {
        matrix = await captureSvc.evaluateSourcesBatchForViewers(
          uniqueViewers,
          captureRefs,
        );
      } else if (typeof captureSvc.evaluateSourcesBatch === 'function') {
        matrix = await Promise.all(
          uniqueViewers.map((viewer) =>
            captureSvc.evaluateSourcesBatch
              ? captureSvc.evaluateSourcesBatch(viewer, captureRefs)
              : Promise.all(
                  captureRefs.map((ref) =>
                    this.captureSourceService.evaluateSource(viewer, ref),
                  ),
                ),
          ),
        );
      } else {
        matrix = await Promise.all(
          uniqueViewers.map((viewer) =>
            Promise.all(
              captureRefs.map((ref) =>
                this.captureSourceService.evaluateSource(viewer, ref),
              ),
            ),
          ),
        );
      }
      for (let vIdx = 0; vIdx < uniqueViewers.length; vIdx += 1) {
        const row = matrix[vIdx] ?? [];
        for (let rIdx = 0; rIdx < captureEntries.length; rIdx += 1) {
          if (row[rIdx]) {
            uniqueMaps[vIdx].set(captureEntries[rIdx].key, row[rIdx]);
          }
        }
      }
    };

    await Promise.all([evaluateLifecycle(), evaluateCapture()]);
    return inputToUniqueIndex.map((idx) => uniqueMaps[idx]);
  }

  async discoverOfficialCandidates(
    viewer: HandoverSourceViewer,
    departingUserId: string,
    query: string,
    limit = 30,
  ): Promise<EvaluatedHandoverSource[]> {
    const [captureCandidates, lifecycleCandidates] = await Promise.all([
      this.captureSourceService.discoverCandidateSources(
        viewer,
        departingUserId,
        query,
        limit,
      ),
      this.lifecycleSourceService.discoverCandidateSources(
        viewer,
        departingUserId,
        query,
        limit,
      ),
    ]);

    return [...captureCandidates, ...lifecycleCandidates]
      .filter((c) => c.kind !== 'TASK_NOTE' && c.eligible && c.readable)
      .slice(0, limit);
  }

  async discoverDepartingMemberFullScope(
    viewer: HandoverSourceViewer,
    departingUserId: string,
    taskIds: readonly string[] = [],
    limit = 50,
  ): Promise<{
    sources: DepartingMemberSourceDto[];
    evaluatedMap: Map<string, EvaluatedHandoverSource>;
  }> {
    const [captureItems, lifecycleItems] = await Promise.all([
      typeof this.captureSourceService.discoverDepartingMemberScopeSources ===
      'function'
        ? this.captureSourceService.discoverDepartingMemberScopeSources(
            viewer,
            departingUserId,
            taskIds,
            limit,
          )
        : Promise.resolve([]),
      typeof this.lifecycleSourceService.discoverCandidateSources === 'function'
        ? this.lifecycleSourceService.discoverCandidateSources(
            viewer,
            departingUserId,
            '',
            limit,
          )
        : Promise.resolve([]),
    ]);

    const combined = [
      ...captureItems,
      ...lifecycleItems
        .filter((c) => c.eligible && c.readable && c.isCurrent)
        .map((evaluated) => ({
          evaluated,
          isDepartingAuthor: true,
        })),
    ].slice(0, limit);

    const evaluatedMap = new Map<string, EvaluatedHandoverSource>();
    const sources: DepartingMemberSourceDto[] = [];

    for (const { evaluated, isDepartingAuthor } of combined) {
      const ref: SourceRefDto = {
        kind: evaluated.kind,
        id: evaluated.id.toLowerCase(),
        version: String(evaluated.version),
      };
      const key = sourceRefKey(ref);
      if (evaluatedMap.has(key)) continue;
      evaluatedMap.set(key, evaluated);

      const firstExcerpt = evaluated.excerpts[0];
      const summaryText = firstExcerpt?.content
        ? firstExcerpt.content.replace(/\s+/g, ' ').trim().slice(0, 280)
        : evaluated.title;
      sources.push({
        kind: evaluated.kind,
        id: evaluated.id.toLowerCase(),
        version: String(evaluated.version),
        title: evaluated.title || `${evaluated.kind} v${evaluated.version}`,
        summary: summaryText,
        locator: {
          kind: firstExcerpt?.locatorKind ?? 'SECTION',
          value: firstExcerpt?.locatorValue ?? 'body-1',
        },
        isDepartingAuthor,
      });
    }

    return { sources, evaluatedMap };
  }

  async countDepartingMemberSourcesByProjects(
    organizationId: string,
    projectIds: readonly string[],
    departingUserId: string,
  ): Promise<
    Map<
      string,
      {
        taskNoteCount: number;
        documentCount: number;
        workReportCount: number;
      }
    >
  > {
    if (
      typeof this.captureSourceService
        .countDepartingMemberCaptureSourcesByProjects === 'function'
    ) {
      return this.captureSourceService.countDepartingMemberCaptureSourcesByProjects(
        organizationId,
        projectIds,
        departingUserId,
      );
    }
    return new Map();
  }
}
