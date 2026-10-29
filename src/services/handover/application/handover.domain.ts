import { createHash } from 'node:crypto';
import type { EvaluatedHandoverSource } from '../../capture/application/handover-capture-source.service';
import type {
  AvailableItemDto,
  CitationDto,
  DraftItemInputDto,
  HandoverCapability,
  ItemProjectionDto,
  SourceRefDto,
  StoredAcceptanceDoc,
  StoredEvidenceDoc,
  StoredEvidenceReviewDoc,
  StoredFollowUpDoc,
  StoredHandoverDoc,
  StoredHandoverItemSnapshot,
  StoredOperationDoc,
  StoredRevisionDoc,
  TaskTransferAggregateState,
  TaskTransferResultDto,
} from './handover.types';

export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`)
    .join(',')}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function computeCommandFingerprint(input: {
  operation: string;
  organizationId: string;
  projectId: string;
  resourceScope: string;
  expectedVersion?: number | null;
  payload: unknown;
}): string {
  return sha256Hex(
    canonicalizeJson({
      operation: input.operation,
      organizationId: input.organizationId.toLowerCase(),
      projectId: input.projectId.toLowerCase(),
      resourceScope: input.resourceScope,
      expectedVersion: input.expectedVersion ?? null,
      payload: input.payload,
    }),
  );
}

export function parseSourceVersionNumber(rawVersion: string): number | null {
  const trimmed = rawVersion.trim();
  const normalized =
    trimmed.startsWith('v') || trimmed.startsWith('V')
      ? trimmed.slice(1)
      : trimmed;
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    return null;
  }
  const num = Number(normalized);
  return Number.isSafeInteger(num) && num >= 1 ? num : null;
}

export function sourceRefKey(ref: SourceRefDto): string {
  const verNum = parseSourceVersionNumber(ref.version);
  const verPart = verNum !== null ? String(verNum) : ref.version.trim();
  return `${ref.kind}:${ref.id.toLowerCase()}:${verPart}`;
}

export function computeSourceSelectionFingerprint(
  sources: readonly SourceRefDto[],
): string {
  const sorted = [...sources]
    .map((s) => ({
      kind: s.kind,
      id: s.id.toLowerCase(),
      version: String(parseSourceVersionNumber(s.version) ?? s.version.trim()),
    }))
    .sort((a, b) =>
      `${a.kind}:${a.id}:${a.version}`.localeCompare(
        `${b.kind}:${b.id}:${b.version}`,
      ),
    );
  return sha256Hex(canonicalizeJson(sorted));
}

export function computeDependencyFingerprint(input: {
  sources: readonly SourceRefDto[];
  citations: readonly CitationDto[];
  isRequired: boolean;
  evidenceRequired: boolean;
}): string {
  const sortedSources = [...input.sources]
    .map((s) => ({
      kind: s.kind,
      id: s.id.toLowerCase(),
      version: String(parseSourceVersionNumber(s.version) ?? s.version.trim()),
    }))
    .sort((a, b) =>
      `${a.kind}:${a.id}:${a.version}`.localeCompare(
        `${b.kind}:${b.id}:${b.version}`,
      ),
    );
  const sortedCitations = [...input.citations]
    .map((c) => ({
      source: {
        kind: c.source.kind,
        id: c.source.id.toLowerCase(),
        version: String(
          parseSourceVersionNumber(c.source.version) ?? c.source.version.trim(),
        ),
      },
      locator: {
        kind: c.locator.kind,
        value: c.locator.value,
      },
    }))
    .sort((a, b) =>
      `${a.source.kind}:${a.source.id}:${a.source.version}:${a.locator.kind}:${a.locator.value}`.localeCompare(
        `${b.source.kind}:${b.source.id}:${b.source.version}:${b.locator.kind}:${b.locator.value}`,
      ),
    );

  return sha256Hex(
    canonicalizeJson({
      isRequired: input.isRequired,
      evidenceRequired: input.evidenceRequired,
      sources: sortedSources,
      citations: sortedCitations,
    }),
  );
}

export function hasMeaningfulDraftItemChange(
  previous: StoredHandoverItemSnapshot,
  next: DraftItemInputDto,
): boolean {
  const nextDepFp = computeDependencyFingerprint({
    sources: next.sources,
    citations: next.citations,
    isRequired: next.isRequired,
    evidenceRequired: next.evidenceRequired,
  });
  return (
    previous.title !== next.title ||
    previous.body !== next.body ||
    previous.requirement !== next.requirement ||
    previous.isRequired !== next.isRequired ||
    previous.evidenceRequired !== next.evidenceRequired ||
    previous.dependencyFingerprint !== nextDepFp
  );
}

export function deriveTaskIntentId(transferId: string, taskId: string): string {
  const hex = sha256Hex(
    `handover-transfer:${transferId.toLowerCase()}:task:${taskId.toLowerCase()}`,
  );
  // Deterministic UUIDv4 formatting (version 4, RFC 4122 variant 8..b)
  const variantNibble = (
    (parseInt(hex.slice(16, 17), 16) & 0x3) |
    0x8
  ).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variantNibble}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function aggregateTaskTransferState(
  tasks: readonly TaskTransferResultDto[],
): TaskTransferAggregateState {
  if (tasks.some((t) => t.state === 'PENDING')) {
    return 'PENDING';
  }
  if (tasks.some((t) => t.state === 'UNKNOWN')) {
    return 'UNKNOWN';
  }
  const allConfirmed = tasks.every((t) => t.state === 'CONFIRMED');
  if (allConfirmed) {
    return 'CONFIRMED';
  }
  const someConfirmed = tasks.some((t) => t.state === 'CONFIRMED');
  if (someConfirmed) {
    return 'PARTIAL';
  }
  if (tasks.some((t) => t.state === 'CONFLICT')) {
    return 'CONFLICT';
  }
  return 'FAILED';
}

export function hasUnresolvedTaskTransferFence(
  operations: readonly Pick<StoredOperationDoc, 'kind' | 'state'>[],
): boolean {
  return operations.some(
    (op) =>
      (op.kind === 'TASK_TRANSFER' || op.kind === 'TASK_TRANSFER_CHILD') &&
      (op.state === 'PENDING' ||
        op.state === 'DISPATCHED' ||
        op.state === 'UNKNOWN'),
  );
}

export function collectItemDependencyRefs(
  item: Pick<StoredHandoverItemSnapshot, 'sources' | 'citations'>,
): SourceRefDto[] {
  const map = new Map<string, SourceRefDto>();
  for (const s of item.sources) {
    map.set(sourceRefKey(s), s);
  }
  for (const c of item.citations) {
    map.set(sourceRefKey(c.source), c.source);
  }
  return [...map.values()];
}

export interface ItemBindingState {
  latestItemAcceptance: StoredAcceptanceDoc | null;
  latestEvidence: StoredEvidenceDoc | null;
  latestEvidenceReview: StoredEvidenceReviewDoc | null;
  hasAcceptedOptionalException: boolean;
}

export function resolveItemBindingState(input: {
  revisionId: string;
  successorUserId: string | null;
  assignmentVersion: number;
  item: StoredHandoverItemSnapshot;
  acceptances: readonly StoredAcceptanceDoc[];
  evidences: readonly StoredEvidenceDoc[];
  evidenceReviews: readonly StoredEvidenceReviewDoc[];
  followUps: readonly StoredFollowUpDoc[];
}): ItemBindingState {
  const itemHex = input.item.itemId.toHexString();
  const revHex = input.revisionId.toLowerCase();
  const hasAcceptedOptionalException =
    !input.item.isRequired &&
    input.followUps.some(
      (f) =>
        f.revisionId.toHexString() === revHex &&
        f.itemId.toHexString() === itemHex,
    );

  if (!input.successorUserId) {
    return {
      latestItemAcceptance: null,
      latestEvidence: null,
      latestEvidenceReview: null,
      hasAcceptedOptionalException,
    };
  }

  const succLower = input.successorUserId.toLowerCase();
  const matchingAcceptances = input.acceptances
    .filter(
      (a) =>
        a.kind === 'ITEM' &&
        a.revisionId.toHexString() === revHex &&
        a.successorUserId.toLowerCase() === succLower &&
        a.assignmentVersion === input.assignmentVersion &&
        a.itemId?.toHexString() === itemHex &&
        a.contentVersion === input.item.contentVersion &&
        a.dependencyFingerprint === input.item.dependencyFingerprint,
    )
    .sort((a, b) => b.sequence - a.sequence);

  const latestItemAcceptance = matchingAcceptances[0] ?? null;

  const matchingEvidences = input.evidences
    .filter(
      (e) =>
        e.revisionId.toHexString() === revHex &&
        e.successorUserId.toLowerCase() === succLower &&
        e.assignmentVersion === input.assignmentVersion &&
        e.itemId.toHexString() === itemHex &&
        e.contentVersion === input.item.contentVersion &&
        e.dependencyFingerprint === input.item.dependencyFingerprint,
    )
    .sort((a, b) => b.sequence - a.sequence);

  const latestEvidence = matchingEvidences[0] ?? null;

  let latestEvidenceReview: StoredEvidenceReviewDoc | null = null;
  if (latestEvidence) {
    const matchingReviews = input.evidenceReviews
      .filter(
        (r) =>
          r.evidenceId.toHexString() === latestEvidence._id.toHexString() &&
          r.revisionId.toHexString() === revHex &&
          r.successorUserId.toLowerCase() === succLower &&
          r.assignmentVersion === input.assignmentVersion &&
          r.itemId.toHexString() === itemHex &&
          r.contentVersion === input.item.contentVersion &&
          r.dependencyFingerprint === input.item.dependencyFingerprint,
      )
      .sort((a, b) => b.sequence - a.sequence);
    latestEvidenceReview = matchingReviews[0] ?? null;
  }

  return {
    latestItemAcceptance,
    latestEvidence,
    latestEvidenceReview,
    hasAcceptedOptionalException,
  };
}

export function projectRevisionItemForViewer(input: {
  item: StoredHandoverItemSnapshot;
  contentReviewDecision: 'CONTENT_APPROVED' | 'GAP_REMAINS';
  bindingState: ItemBindingState;
  viewerSourceMap: ReadonlyMap<string, EvaluatedHandoverSource>;
}): ItemProjectionDto {
  const itemId = input.item.itemId.toHexString();
  const deps = collectItemDependencyRefs(input.item);

  let allCurrent = true;
  for (const dep of deps) {
    const evaluated = input.viewerSourceMap.get(sourceRefKey(dep));
    if (!evaluated || !evaluated.eligible || !evaluated.readable) {
      // Strict fail-closed UnavailableItem shell (A04 / A13)
      return {
        itemId,
        access: 'UNAVAILABLE',
      };
    }
    if (!evaluated.isCurrent) {
      allCurrent = false;
    }
  }

  const acknowledgement: AvailableItemDto['acknowledgement'] = input
    .bindingState.latestItemAcceptance
    ? (input.bindingState.latestItemAcceptance.decision as
        'UNDERSTOOD' | 'NEEDS_CLARIFICATION')
    : 'PENDING';

  let evidenceReview: AvailableItemDto['evidenceReview'] = 'NOT_REQUIRED';
  if (input.item.evidenceRequired) {
    if (
      !input.bindingState.latestEvidence ||
      !input.bindingState.latestEvidenceReview
    ) {
      evidenceReview = 'PENDING';
    } else {
      evidenceReview =
        input.bindingState.latestEvidenceReview.decision === 'APPROVED'
          ? 'ACCEPTED'
          : 'CHANGES_REQUESTED';
    }
  }

  return {
    itemId,
    access: 'AVAILABLE',
    contentVersion: input.item.contentVersion,
    title: input.item.title,
    body: input.item.body,
    isRequired: input.item.isRequired,
    evidenceRequired: input.item.evidenceRequired,
    requirement: input.item.requirement,
    sources: input.item.sources,
    citations: input.item.citations,
    contentReview: input.contentReviewDecision,
    acknowledgement,
    evidenceReview,
    optionalExceptionAccepted: input.bindingState.hasAcceptedOptionalException,
    sourceState: allCurrent ? 'CURRENT' : 'CHANGED',
  };
}

export function evaluateCarriedItemAcceptances(input: {
  previousRevision: StoredRevisionDoc | null;
  newItems: readonly StoredHandoverItemSnapshot[];
  reviews: ReadonlyArray<{
    itemId: string;
    contentVersion: number;
    decision: 'CONTENT_APPROVED' | 'GAP_REMAINS';
    impact: 'UNCHANGED' | 'CHANGED';
  }>;
  successorUserId: string | null;
  assignmentVersion: number;
  previousAcceptances: readonly StoredAcceptanceDoc[];
  successorSourceMap: ReadonlyMap<string, EvaluatedHandoverSource>;
}): Array<{
  item: StoredHandoverItemSnapshot;
  carriedFromAcceptanceId: StoredAcceptanceDoc['_id'];
  note: string;
}> {
  if (
    !input.previousRevision ||
    !input.successorUserId ||
    input.previousRevision.successorUserId?.toLowerCase() !==
      input.successorUserId.toLowerCase() ||
    input.previousRevision.assignmentVersion !== input.assignmentVersion
  ) {
    return [];
  }

  const prevRevHex = input.previousRevision._id.toHexString();
  const succLower = input.successorUserId.toLowerCase();
  const reviewByItem = new Map(
    input.reviews.map((r) => [r.itemId.toLowerCase(), r]),
  );
  const prevItemById = new Map(
    input.previousRevision.items.map((it) => [it.itemId.toHexString(), it]),
  );

  const carried: Array<{
    item: StoredHandoverItemSnapshot;
    carriedFromAcceptanceId: StoredAcceptanceDoc['_id'];
    note: string;
  }> = [];

  for (const newItem of input.newItems) {
    const itemHex = newItem.itemId.toHexString();
    const review = reviewByItem.get(itemHex);
    if (!review || review.impact !== 'UNCHANGED') {
      continue;
    }
    const prevItem = prevItemById.get(itemHex);
    if (
      !prevItem ||
      prevItem.contentVersion !== newItem.contentVersion ||
      prevItem.dependencyFingerprint !== newItem.dependencyFingerprint
    ) {
      continue;
    }

    // Reverify current source eligibility, readability, and freshness for successor B before carrying (H-14 / A09)
    const deps = collectItemDependencyRefs(newItem);
    const depsReadableAndCurrent = deps.every((dep) => {
      const ev = input.successorSourceMap.get(sourceRefKey(dep));
      return Boolean(ev && ev.eligible && ev.readable && ev.isCurrent);
    });
    if (!depsReadableAndCurrent) {
      continue;
    }

    const matchingPrevAcc = input.previousAcceptances
      .filter(
        (a) =>
          a.kind === 'ITEM' &&
          a.revisionId.toHexString() === prevRevHex &&
          a.successorUserId.toLowerCase() === succLower &&
          a.assignmentVersion === input.assignmentVersion &&
          a.itemId?.toHexString() === itemHex &&
          a.contentVersion === newItem.contentVersion &&
          a.dependencyFingerprint === newItem.dependencyFingerprint,
      )
      .sort((a, b) => b.sequence - a.sequence)[0];

    if (matchingPrevAcc && matchingPrevAcc.decision === 'UNDERSTOOD') {
      carried.push({
        item: newItem,
        carriedFromAcceptanceId: matchingPrevAcc._id,
        note: matchingPrevAcc.note,
      });
    }
  }

  return carried;
}

export interface CompletionBlocker {
  code: string;
  itemId?: string;
  transferId?: string;
  taskId?: string;
}

export interface LiveHandoverTaskState {
  exists: boolean;
  status: string | null;
  version: number | null;
  assigneeId: string | null;
}

export interface CompletionEvaluationResult {
  canComplete: boolean;
  requiredPendingCount: number;
  packageAccepted: boolean;
  blockers: CompletionBlocker[];
}

export function evaluateCompletionReadiness(input: {
  handover: StoredHandoverDoc;
  currentRevision: StoredRevisionDoc | null;
  acceptances: readonly StoredAcceptanceDoc[];
  evidences: readonly StoredEvidenceDoc[];
  evidenceReviews: readonly StoredEvidenceReviewDoc[];
  followUps: readonly StoredFollowUpDoc[];
  transferOperations: readonly StoredOperationDoc[];
  transferChildOperations: readonly StoredOperationDoc[];
  leaderSourceMap: ReadonlyMap<string, EvaluatedHandoverSource>;
  successorSourceMap: ReadonlyMap<string, EvaluatedHandoverSource>;
  liveTaskStateMap?: ReadonlyMap<string, LiveHandoverTaskState>;
}): CompletionEvaluationResult {
  const blockers: CompletionBlocker[] = [];
  let requiredPendingCount = 0;

  if (input.handover.status !== 'OPEN') {
    blockers.push({ code: 'HANDOVER_NOT_OPEN' });
  }
  if (!input.handover.successorUserId) {
    blockers.push({ code: 'SUCCESSOR_NOT_ASSIGNED' });
  }
  if (!input.handover.publishedRevisionId || !input.currentRevision) {
    blockers.push({ code: 'NO_PUBLISHED_REVISION' });
    return {
      canComplete: false,
      requiredPendingCount,
      packageAccepted: false,
      blockers,
    };
  }

  const revHex = input.currentRevision._id.toHexString();
  const succLower = input.handover.successorUserId?.toLowerCase() ?? null;
  const packageAccepted = Boolean(
    succLower &&
    input.acceptances.some(
      (a) =>
        a.kind === 'PACKAGE' &&
        a.decision === 'ACCEPTED' &&
        a.revisionId.toHexString() === revHex &&
        a.successorUserId.toLowerCase() === succLower &&
        a.assignmentVersion === input.handover.assignmentVersion,
    ),
  );

  if (!packageAccepted) {
    blockers.push({ code: 'PACKAGE_NOT_ACCEPTED_BY_CURRENT_SUCCESSOR' });
  }

  const reviewByItem = new Map(
    input.currentRevision.reviews.map((r) => [r.itemId.toHexString(), r]),
  );

  for (const item of input.currentRevision.items) {
    const itemHex = item.itemId.toHexString();
    const revReview = reviewByItem.get(itemHex);
    const contentApproved = revReview?.decision === 'CONTENT_APPROVED';

    const deps = collectItemDependencyRefs(item);
    const depsAccessible = deps.every((dep) => {
      const key = sourceRefKey(dep);
      const leaderEv = input.leaderSourceMap.get(key);
      const succEv = succLower ? input.successorSourceMap.get(key) : undefined;
      return Boolean(
        leaderEv?.eligible &&
        leaderEv?.readable &&
        succEv?.eligible &&
        succEv?.readable,
      );
    });
    const depsCurrent = deps.every((dep) => {
      const key = sourceRefKey(dep);
      const leaderEv = input.leaderSourceMap.get(key);
      const succEv = succLower ? input.successorSourceMap.get(key) : undefined;
      return Boolean(leaderEv?.isCurrent && succEv?.isCurrent);
    });

    const binding = resolveItemBindingState({
      revisionId: revHex,
      successorUserId: succLower,
      assignmentVersion: input.handover.assignmentVersion,
      item,
      acceptances: input.acceptances,
      evidences: input.evidences,
      evidenceReviews: input.evidenceReviews,
      followUps: input.followUps,
    });

    const itemUnderstood =
      binding.latestItemAcceptance?.decision === 'UNDERSTOOD';
    const evidenceSatisfied =
      !item.evidenceRequired ||
      (Boolean(binding.latestEvidence) &&
        binding.latestEvidenceReview?.decision === 'APPROVED');

    const itemResolved =
      contentApproved &&
      depsAccessible &&
      depsCurrent &&
      itemUnderstood &&
      evidenceSatisfied;

    if (item.isRequired) {
      if (!itemResolved) {
        requiredPendingCount += 1;
        blockers.push({
          code: !depsAccessible
            ? 'REQUIRED_ITEM_DEPENDENCY_UNAVAILABLE'
            : !depsCurrent
              ? 'REQUIRED_ITEM_SOURCE_OUTDATED'
              : !contentApproved
                ? 'REQUIRED_ITEM_GAP_REMAINS'
                : !itemUnderstood
                  ? 'REQUIRED_ITEM_NOT_UNDERSTOOD'
                  : 'REQUIRED_ITEM_EVIDENCE_UNAPPROVED',
          itemId: itemHex,
        });
      }
    } else if (!itemResolved && !binding.hasAcceptedOptionalException) {
      blockers.push({
        code: 'OPTIONAL_ITEM_UNRESOLVED_WITHOUT_EXCEPTION',
        itemId: itemHex,
      });
    }
  }

  // Task transfer checks:
  // 1. Any in-flight / ambiguous transfer across any epoch/revision fences completion.
  // 2. Terminal PARTIAL / CONFLICT on the current revision + assignment epoch blocks completion
  //    until Leader updates scope & publishes a clean revision (or confirms all selected tasks).
  for (const transferOp of input.transferOperations) {
    if (
      transferOp.state === 'PENDING' ||
      transferOp.state === 'DISPATCHED' ||
      transferOp.state === 'UNKNOWN'
    ) {
      blockers.push({
        code: `TASK_TRANSFER_${transferOp.state}`,
        transferId: transferOp._id.toHexString(),
      });
      continue;
    }
    const isCurrentRevisionBinding =
      transferOp.revisionId?.toHexString() === revHex &&
      transferOp.assignmentVersion === input.handover.assignmentVersion &&
      succLower !== null &&
      transferOp.successorUserId?.toLowerCase() === succLower;
    if (
      isCurrentRevisionBinding &&
      (transferOp.state === 'PARTIAL' || transferOp.state === 'CONFLICT')
    ) {
      blockers.push({
        code: `TASK_TRANSFER_${transferOp.state}`,
        transferId: transferOp._id.toHexString(),
      });
    }
  }

  if (input.currentRevision.selectedTasks.length > 0) {
    const confirmedTaskIds = new Set(
      input.transferChildOperations
        .filter(
          (child) =>
            child.revisionId?.toHexString() === revHex &&
            child.assignmentVersion === input.handover.assignmentVersion &&
            succLower !== null &&
            child.successorUserId?.toLowerCase() === succLower &&
            child.state === 'COMMITTED' &&
            child.taskOutcome?.state === 'COMMITTED' &&
            child.taskIntent?.taskId,
        )
        .map((child) => child.taskIntent!.taskId.toHexString()),
    );

    for (const selectedTask of input.currentRevision.selectedTasks) {
      const taskHex = selectedTask.taskId.toHexString();
      if (!confirmedTaskIds.has(taskHex)) {
        blockers.push({
          code: 'SELECTED_TASK_TRANSFER_NOT_CONFIRMED',
          taskId: taskHex,
        });
        break;
      }
    }

    if (input.liveTaskStateMap) {
      for (const selectedTask of input.currentRevision.selectedTasks) {
        const taskHex = selectedTask.taskId.toHexString();
        const liveTask = input.liveTaskStateMap.get(taskHex.toLowerCase());
        if (!liveTask || !liveTask.exists) {
          blockers.push({
            code: 'SELECTED_TASK_NOT_FOUND',
            taskId: taskHex,
          });
          continue;
        }
        if (succLower && liveTask.assigneeId?.toLowerCase() !== succLower) {
          blockers.push({
            code: 'SELECTED_TASK_ASSIGNEE_DRIFTED',
            taskId: taskHex,
          });
        }
      }
    }
  }

  return {
    canComplete: blockers.length === 0,
    requiredPendingCount,
    packageAccepted,
    blockers,
  };
}

export function resolveHandoverCapabilities(input: {
  actorUserId: string;
  isProjectMember: boolean;
  isProjectLeader: boolean;
  handover: StoredHandoverDoc;
  packageAcceptedByCurrentSuccessor: boolean;
  isFollowUpOwner: boolean;
}): HandoverCapability[] {
  if (!input.isProjectMember) {
    return [];
  }
  const actorLower = input.actorUserId.toLowerCase();
  const isAssignedCoordinator =
    input.isProjectLeader &&
    input.handover.assignedLeaderId.toLowerCase() === actorLower;
  const isScopedLeader = input.isProjectLeader || isAssignedCoordinator;
  const isCurrentSuccessor =
    input.handover.successorUserId !== null &&
    input.handover.successorUserId.toLowerCase() === actorLower;
  const isDepartingMember =
    input.handover.departingUserId.toLowerCase() === actorLower;

  const canRead =
    isScopedLeader ||
    isCurrentSuccessor ||
    isDepartingMember ||
    input.isFollowUpOwner;

  if (!canRead) {
    return [];
  }

  const caps = new Set<HandoverCapability>(['READ']);

  if (isScopedLeader) {
    caps.add('MANAGE');
    caps.add('REVIEW');
    caps.add('FOLLOW_UP');
    if (
      input.handover.status === 'OPEN' &&
      input.handover.publishedRevisionId !== null &&
      input.handover.successorUserId !== null &&
      input.packageAcceptedByCurrentSuccessor
    ) {
      caps.add('TRANSFER');
    }
  }

  if (
    isCurrentSuccessor &&
    input.handover.status === 'OPEN' &&
    input.handover.publishedRevisionId !== null
  ) {
    caps.add('RECEIVE');
  }

  if (isCurrentSuccessor || input.isFollowUpOwner) {
    caps.add('FOLLOW_UP');
  }

  return [...caps];
}
