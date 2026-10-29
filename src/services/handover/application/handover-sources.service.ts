import { Injectable } from '@nestjs/common';
import {
  HandoverCaptureSourceService,
  type EvaluatedHandoverSource,
  type HandoverSourceViewer,
} from '../../capture/application/handover-capture-source.service';
import { HandoverLifecycleSourceService } from '../../lifecycle/application/handover-lifecycle-source.service';
import { parseSourceVersionNumber, sourceRefKey } from './handover.domain';
import type { SourceRefDto } from './handover.types';

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
}
