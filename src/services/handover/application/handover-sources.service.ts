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
    const uniqueByKey = new Map<string, SourceRefDto>();
    for (const ref of refs) {
      uniqueByKey.set(sourceRefKey(ref), ref);
    }

    const entries = await Promise.all(
      [...uniqueByKey.entries()].map(async ([key, ref]) => {
        const evaluated = await this.evaluateSourceRef(viewer, ref);
        return [key, evaluated] as const;
      }),
    );

    return new Map(entries);
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
