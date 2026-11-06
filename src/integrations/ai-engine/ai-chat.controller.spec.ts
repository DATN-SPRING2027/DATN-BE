import { EventEmitter } from 'node:events';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AiChatController } from './ai-chat.controller';
import type { AiChatService } from './ai-chat.service';
import type { AiChatSseFrame } from './ai-chat.types';
import type { WorkNotesService } from '../../services/capture/application/work-notes.service';

describe('AiChatController', () => {
  function setup() {
    const createThreadMock = jest.fn();
    const branchThreadMock = jest.fn();
    const openAskStreamMock = jest.fn();
    const getOwnFeedbackMock = jest.fn();
    const putOwnFeedbackMock = jest.fn();
    const deleteOwnFeedbackMock = jest.fn();
    const createShareMock = jest.fn();
    const readSharedAnswerMock = jest.fn();
    const revokeShareMock = jest.fn();
    const openRegenerateStreamMock = jest.fn();
    const getMindMapMock = jest.fn();
    const generateMindMapMock = jest.fn();
    const resolveAllProjectsManagerContextMock = jest.fn();
    const getKnowledgeUniverseOverviewMock = jest.fn();
    const getKnowledgeUniverseClusterMock = jest.fn();
    const getKnowledgeUniverseUnitMock = jest.fn();
    const resolveKnowledgeUniverseReferencesMock = jest.fn();
    const listAiChatProjectSourcesMock = jest.fn();
    const listAiChatAllProjectsSourcesMock = jest.fn();
    const service = {
      listThreads: jest.fn(),
      createThread: createThreadMock,
      branchThread: branchThreadMock,
      updateThread: jest.fn(),
      deleteThread: jest.fn(),
      listMessages: jest.fn(),
      openAskStream: openAskStreamMock,
      getOwnFeedback: getOwnFeedbackMock,
      putOwnFeedback: putOwnFeedbackMock,
      deleteOwnFeedback: deleteOwnFeedbackMock,
      createShare: createShareMock,
      readSharedAnswer: readSharedAnswerMock,
      revokeShare: revokeShareMock,
      openRegenerateStream: openRegenerateStreamMock,
      getMindMap: getMindMapMock,
      generateMindMap: generateMindMapMock,
      resolveAllProjectsManagerContext: resolveAllProjectsManagerContextMock,
      getKnowledgeUniverseOverview: getKnowledgeUniverseOverviewMock,
      getKnowledgeUniverseCluster: getKnowledgeUniverseClusterMock,
      getKnowledgeUniverseUnit: getKnowledgeUniverseUnitMock,
      resolveKnowledgeUniverseReferences:
        resolveKnowledgeUniverseReferencesMock,
    } as unknown as AiChatService;
    const workNotes = {
      listAiChatProjectSources: listAiChatProjectSourcesMock,
      listAiChatAllProjectsSources: listAiChatAllProjectsSourcesMock,
    } as unknown as WorkNotesService;
    const controller = new AiChatController(service, workNotes);
    return {
      controller,
      createThreadMock,
      branchThreadMock,
      openAskStreamMock,
      getOwnFeedbackMock,
      putOwnFeedbackMock,
      deleteOwnFeedbackMock,
      createShareMock,
      readSharedAnswerMock,
      revokeShareMock,
      openRegenerateStreamMock,
      getMindMapMock,
      generateMindMapMock,
      resolveAllProjectsManagerContextMock,
      getKnowledgeUniverseOverviewMock,
      getKnowledgeUniverseClusterMock,
      getKnowledgeUniverseUnitMock,
      resolveKnowledgeUniverseReferencesMock,
      listAiChatProjectSourcesMock,
      listAiChatAllProjectsSourcesMock,
    };
  }

  function makeReq(headers: Record<string, string> = {}): Request {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      headers,
    }) as unknown as Request;
  }

  function makeRes() {
    const headers: Record<string, string> = {};
    const chunks: string[] = [];
    let statusCode = 200;
    let ended = false;
    class MockResponse extends EventEmitter {
      destroyed = false;
      headersSent = false;
      writableEnded = false;
      setHeader = jest.fn((key: string, value: string) => {
        headers[key.toLowerCase()] = value;
      });
      status = jest.fn((code: number) => {
        statusCode = code;
        return this;
      });
      flushHeaders = jest.fn(() => {
        this.headersSent = true;
      });
      write = jest.fn((chunk: string) => {
        chunks.push(chunk);
        return true;
      });
      end = jest.fn(() => {
        ended = true;
        this.writableEnded = true;
      });
    }
    const mockRes = new MockResponse();
    return {
      res: mockRes as unknown as Response & EventEmitter,
      headers,
      chunks,
      getStatus: () => statusCode,
      isEnded: () => ended,
    };
  }

  it('rejects cookie-authenticated mutations when x-csrf-token is missing or mismatched', async () => {
    const { controller, createThreadMock } = setup();
    const { res } = makeRes();

    await expect(
      controller.createThread(
        makeReq({
          cookie: 'continuum_access=jwt; __Host-csrf=expected-csrf-token-1234',
          'x-csrf-token': 'wrong-token',
        }),
        res,
        'proj-1',
        { title: 'Architecture Q&A' },
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(createThreadMock).not.toHaveBeenCalled();
  });

  it('allows cookie-authenticated mutations with matching x-csrf-token and validates DTO constraints', async () => {
    const { controller, createThreadMock } = setup();
    const { res } = makeRes();
    createThreadMock.mockResolvedValueOnce({
      id: 't1',
      title: 'Architecture Q&A',
      createdAt: '2026-10-28T10:00:00Z',
      updatedAt: '2026-10-28T10:00:00Z',
    });

    const created = await controller.createThread(
      makeReq({
        cookie: 'continuum_access=jwt; continuum_csrf=csrf-ok-token',
        'x-csrf-token': 'csrf-ok-token',
      }),
      res,
      'proj-1',
      { title: '  Architecture Q&A  ' },
    );

    expect(created.id).toBe('t1');
    expect(createThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cookie: 'continuum_access=jwt; continuum_csrf=csrf-ok-token',
      }),
      'proj-1',
      { title: 'Architecture Q&A' },
    );

    await expect(
      controller.ask(
        makeReq({ authorization: 'Bearer token' }),
        res,
        'proj-1',
        't1',
        { query: '   ' },
      ),
    ).rejects.toThrow(BadRequestException);

    await expect(
      controller.ask(
        makeReq({ authorization: 'Bearer token' }),
        res,
        'proj-1',
        't1',
        { query: 'x'.repeat(4001) },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('lists Project document sources with bounded pagination and no-store caching', async () => {
    const { controller, listAiChatProjectSourcesMock } = setup();
    const projectId = '0123456789abcdef01234567';
    const req = makeReq({
      authorization: 'Bearer token',
      'x-organization-id': 'org-1',
    });
    const { res, headers } = makeRes();
    listAiChatProjectSourcesMock.mockResolvedValueOnce({
      data: [],
      pagination: { page: 2, pageSize: 10, totalItems: 0, totalPages: 0 },
      summary: {
        totalCount: 0,
        readyCount: 0,
        verificationStatus: 'VERIFIED',
        verifiedAt: '2026-11-04T00:00:00.000Z',
      },
    });

    const result = await controller.listDocumentSources(req, res, projectId, {
      page: '2',
      pageSize: '10',
    });

    expect(result.pagination).toMatchObject({ page: 2, pageSize: 10 });
    expect(headers['cache-control']).toBe('no-store');
    expect(listAiChatProjectSourcesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: 'Bearer token',
        organizationId: 'org-1',
      }),
      projectId,
      2,
      10,
    );
  });

  it('routes all-projects document-sources ("all") through Manager RBAC context resolution', async () => {
    const {
      controller,
      resolveAllProjectsManagerContextMock,
      listAiChatAllProjectsSourcesMock,
      listAiChatProjectSourcesMock,
    } = setup();
    const req = makeReq({ authorization: 'Bearer manager' });
    const { res } = makeRes();
    const managerScope = {
      actorId: 'u1',
      organizationId: 'org1',
      projects: [{ id: 'p1', code: 'P1', name: 'Project 1' }],
    };
    resolveAllProjectsManagerContextMock.mockResolvedValueOnce(managerScope);
    listAiChatAllProjectsSourcesMock.mockResolvedValueOnce({
      data: [],
      pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 },
      summary: {
        totalCount: 0,
        readyCount: 0,
        verificationStatus: 'VERIFIED',
        verifiedAt: '2026-11-05T00:00:00.000Z',
      },
    });

    await controller.listDocumentSources(req, res, 'all', {});
    expect(resolveAllProjectsManagerContextMock).toHaveBeenCalledTimes(1);
    expect(listAiChatAllProjectsSourcesMock).toHaveBeenCalledWith(
      managerScope,
      1,
      25,
    );
    expect(listAiChatProjectSourcesMock).not.toHaveBeenCalled();
  });

  it('rejects unsupported query parameters for Project document sources', async () => {
    const { controller, listAiChatProjectSourcesMock } = setup();
    const { res } = makeRes();

    await expect(
      controller.listDocumentSources(
        makeReq(),
        res,
        '0123456789abcdef01234567',
        { status: 'APPROVED' },
      ),
    ).rejects.toThrow(BadRequestException);
    expect(listAiChatProjectSourcesMock).not.toHaveBeenCalled();
  });

  it('streams formatted SSE events with no-cache/no-buffering headers and aborts upstream on client close', async () => {
    const { controller, openAskStreamMock } = setup();
    const req = makeReq({ authorization: 'Bearer token' });
    const { res, headers, chunks, isEnded } = makeRes();

    let capturedSignal: AbortSignal | undefined;
    async function* fakeGenerator(): AsyncGenerator<AiChatSseFrame> {
      await Promise.resolve();
      // Express JSON body stream closing must NOT prematurely abort the SSE response stream!
      req.emit('close');
      yield { event: 'delta', data: { text: 'Xin chào' } };
      // Client disconnecting the HTTP response socket MUST abort upstream immediately!
      res.emit('close');
      yield {
        event: 'completed',
        data: {
          messageId: 'm1',
          content: 'Xin chào',
          answerStatus: 'answered',
          citations: [],
          sessionCitations: [],
          retrievalSteps: [],
        },
      };
    }

    openAskStreamMock.mockImplementationOnce(
      (
        _headers: unknown,
        _projectId: string,
        _threadId: string,
        _body: unknown,
        signal?: AbortSignal,
      ) => {
        capturedSignal = signal;
        return Promise.resolve(fakeGenerator());
      },
    );

    await controller.ask(req, res, 'proj-1', 't1', { query: 'Hello' });

    expect(headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(headers['cache-control']).toBe(
      'no-cache, no-store, must-revalidate',
    );
    expect(headers['x-accel-buffering']).toBe('no');
    expect(capturedSignal?.aborted).toBe(true);
    expect(chunks[0]).toBe('event: delta\ndata: {"text":"Xin chào"}\n\n');
    expect(isEnded()).toBe(true);
  });

  it('validates FeedbackInput rules, empty-body share/regenerate mutations, CSRF, and 201/200 share status codes', async () => {
    const {
      controller,
      putOwnFeedbackMock,
      createShareMock,
      openRegenerateStreamMock,
    } = setup();
    const { res, headers, getStatus } = makeRes();

    // LIKE cannot carry reasonCategory or reasonText
    await expect(
      controller.putOwnFeedback(
        makeReq({ authorization: 'Bearer token' }),
        res,
        'proj-1',
        't1',
        'm1',
        { rating: 'LIKE', reasonCategory: 'INACCURATE' },
      ),
    ).rejects.toThrow(BadRequestException);

    // DISLIKE requires reasonCategory, and OTHER requires non-whitespace reasonText <= 1000
    await expect(
      controller.putOwnFeedback(
        makeReq({ authorization: 'Bearer token' }),
        res,
        'proj-1',
        't1',
        'm1',
        { rating: 'DISLIKE' },
      ),
    ).rejects.toThrow(BadRequestException);

    await expect(
      controller.putOwnFeedback(
        makeReq({ authorization: 'Bearer token' }),
        res,
        'proj-1',
        't1',
        'm1',
        { rating: 'DISLIKE', reasonCategory: 'OTHER', reasonText: '   ' },
      ),
    ).rejects.toThrow(BadRequestException);

    // Cookie PUT without CSRF must fail 403
    await expect(
      controller.putOwnFeedback(
        makeReq({ cookie: 'continuum_access=jwt; __Host-csrf=csrf1' }),
        res,
        'proj-1',
        't1',
        'm1',
        { rating: 'LIKE' },
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(putOwnFeedbackMock).not.toHaveBeenCalled();

    // Valid DISLIKE with OTHER reasonText
    putOwnFeedbackMock.mockResolvedValueOnce({
      messageId: 'm1',
      rating: 'DISLIKE',
      reasonCategory: 'OTHER',
      reasonText: 'Thiếu dữ liệu thực tế',
      updatedAt: '2026-10-30T10:00:00Z',
    });
    const saved = await controller.putOwnFeedback(
      makeReq({
        cookie: 'continuum_access=jwt; __Host-csrf=csrf1',
        'x-csrf-token': 'csrf1',
      }),
      res,
      'proj-1',
      't1',
      'm1',
      {
        rating: 'DISLIKE',
        reasonCategory: 'OTHER',
        reasonText: '  Thiếu dữ liệu thực tế  ',
      },
    );
    expect(saved.reasonText).toBe('Thiếu dữ liệu thực tế');
    expect(headers['cache-control']).toBe('no-store');

    // Share rejects unexpected body keys, and preserves 201 vs 200 status
    await expect(
      controller.createShare(
        makeReq({ authorization: 'Bearer token' }),
        res,
        'proj-1',
        't1',
        'm1',
        { unexpected: true },
      ),
    ).rejects.toThrow(BadRequestException);

    createShareMock.mockResolvedValueOnce({
      status: 201,
      share: {
        id: 'sh_1',
        projectId: 'proj-1',
        messageId: 'm1',
        createdAt: '2026-10-30T10:00:00Z',
      },
    });
    const createdShare = await controller.createShare(
      makeReq({ authorization: 'Bearer token' }),
      res,
      'proj-1',
      't1',
      'm1',
      {},
    );
    expect(getStatus()).toBe(201);
    expect(createdShare.id).toBe('sh_1');

    // Regenerate rejects non-empty body keys
    await expect(
      controller.regenerate(
        makeReq({ authorization: 'Bearer token' }),
        res,
        'proj-1',
        't1',
        'm1',
        { query: 'not allowed' },
      ),
    ).rejects.toThrow(BadRequestException);
    expect(openRegenerateStreamMock).not.toHaveBeenCalled();
  });

  it('validates generateMindMap body, enforces CSRF on cookie POST, sets Cache-Control: no-store, and trims topic', async () => {
    const { controller, generateMindMapMock } = setup();
    const { res, headers } = makeRes();

    // Cookie POST without CSRF must fail 403 before calling service
    await expect(
      controller.generateMindMap(
        makeReq({ cookie: 'continuum_access=jwt; __Host-csrf=csrf1' }),
        res,
        'proj-1',
        {},
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(generateMindMapMock).not.toHaveBeenCalled();

    // Rejects unexpected body keys (e.g. sourceIds / partitionId)
    for (const invalidBody of [
      ['not-an-object'],
      { sourceIds: ['src-1'] },
      { topic: '   ' },
      { topic: 'x'.repeat(201) },
      { topic: 123 },
    ]) {
      await expect(
        controller.generateMindMap(
          makeReq({ authorization: 'Bearer token' }),
          res,
          'proj-1',
          invalidBody,
        ),
      ).rejects.toThrow(BadRequestException);
    }
    expect(generateMindMapMock).not.toHaveBeenCalled();

    // Invalid projectId fails 400
    await expect(
      controller.generateMindMap(
        makeReq({ authorization: 'Bearer token' }),
        res,
        '../bad',
        {},
      ),
    ).rejects.toThrow(BadRequestException);

    // Valid overview ({} / undefined) + valid trimmed topic with cookie + CSRF
    const mockMap = {
      projectId: 'proj-1',
      topic: 'Kiến trúc bàn giao',
      status: 'ready' as const,
      generationMode: 'llm' as const,
      fallbackReason: null,
      scopeFingerprint: 'a'.repeat(64),
      coverage: {
        accessibleReadyDocumentCount: 2,
        usedDocumentCount: 2,
        omittedDocumentCount: 0,
        pendingDocumentCount: 0,
        truncatedDocumentCount: 0,
        evidenceUnitCount: 6,
      },
      tree: {
        id: 'root',
        label: 'Kiến trúc bàn giao',
        summary: 'Tổng quan dự án',
        citationNumbers: [1],
        children: [],
      },
      citations: [],
      generatedAt: '2026-10-30T16:00:00Z',
    };
    generateMindMapMock.mockResolvedValueOnce(mockMap);

    const out = await controller.generateMindMap(
      makeReq({
        cookie: 'continuum_access=jwt; __Host-csrf=csrf1',
        'x-csrf-token': 'csrf1',
      }),
      res,
      'proj-1',
      { topic: '   Kiến trúc   bàn giao  ' },
    );

    expect(headers['cache-control']).toBe('no-store');
    expect(generateMindMapMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cookie: 'continuum_access=jwt; __Host-csrf=csrf1',
        csrfToken: 'csrf1',
      }),
      'proj-1',
      { topic: 'Kiến trúc bàn giao' },
    );
    expect(out).toEqual(mockMap);

    // Rejects non-boolean refresh
    await expect(
      controller.generateMindMap(
        makeReq({ authorization: 'Bearer token' }),
        res,
        'proj-1',
        { refresh: 'true' },
      ),
    ).rejects.toThrow(BadRequestException);

    // Forwards boolean refresh
    generateMindMapMock.mockResolvedValueOnce(mockMap);
    await controller.generateMindMap(
      makeReq({ authorization: 'Bearer token' }),
      res,
      'proj-1',
      { topic: '  API  ', refresh: true },
    );
    expect(generateMindMapMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ authorization: 'Bearer token' }),
      'proj-1',
      { topic: 'API', refresh: true },
    );
  });

  it('validates getMindMap query parameters, sets Cache-Control: no-store, and allows cookie GET without CSRF', async () => {
    const { controller, getMindMapMock } = setup();
    const { res, headers } = makeRes();

    // Rejects invalid query keys, array topic, blank topic, or >200 chars
    for (const invalidQuery of [
      { unexpected: '1' },
      { topic: ['a', 'b'] },
      { topic: '   ' },
      { topic: 'x'.repeat(201) },
      { topic: 'ß'.repeat(101) },
    ]) {
      await expect(
        controller.getMindMap(
          makeReq({ cookie: 'continuum_access=jwt' }),
          res,
          'proj-1',
          invalidQuery as Record<string, string | string[] | undefined>,
        ),
      ).rejects.toThrow(BadRequestException);
    }
    expect(getMindMapMock).not.toHaveBeenCalled();

    const mockUninitialized = {
      projectId: 'proj-1',
      topic: 'Kiến trúc',
      status: 'uninitialized' as const,
      generationMode: 'none' as const,
      fallbackReason: null,
      scopeFingerprint: 'a'.repeat(64),
      cached: false,
      hasSourceUpdates: false,
      coverage: {
        accessibleReadyDocumentCount: 2,
        usedDocumentCount: 0,
        omittedDocumentCount: 0,
        pendingDocumentCount: 0,
        truncatedDocumentCount: 0,
        evidenceUnitCount: 0,
      },
      tree: null,
      citations: [],
      generatedAt: '2026-10-31T05:30:00Z',
    };
    getMindMapMock.mockResolvedValueOnce(mockUninitialized);

    const out = await controller.getMindMap(
      makeReq({ cookie: 'continuum_access=jwt' }),
      res,
      'proj-1',
      { topic: '  Kiến   trúc ' },
    );
    expect(headers['cache-control']).toBe('no-store');
    expect(getMindMapMock).toHaveBeenCalledWith(
      expect.objectContaining({ cookie: 'continuum_access=jwt' }),
      'proj-1',
      'Kiến trúc',
    );
    expect(out).toEqual(mockUninitialized);
  });

  it('enforces CSRF, path validation, strict body rules, and Cache-Control: no-store on branchThread', async () => {
    const { controller, branchThreadMock } = setup();
    const { res, headers } = makeRes();

    // Missing/mismatched CSRF on cookie auth -> 403 Forbidden
    await expect(
      controller.branchThread(
        makeReq({
          cookie: 'continuum_access=jwt; continuum_csrf=csrf-good',
          'x-csrf-token': 'csrf-bad',
        }),
        res,
        'proj-1',
        'thread-1',
        'msg-1',
        {},
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(branchThreadMock).not.toHaveBeenCalled();

    // Invalid path identifiers or body fields -> 400 BadRequestException
    await expect(
      controller.branchThread(
        makeReq({ authorization: 'Bearer token' }),
        res,
        'proj-1',
        'thread-1',
        'bad/id',
        {},
      ),
    ).rejects.toThrow(BadRequestException);

    for (const invalidBody of [
      ['array'],
      { unexpected: true },
      { title: '   ' },
      { title: 'x'.repeat(201) },
      { title: 123 },
    ]) {
      await expect(
        controller.branchThread(
          makeReq({ authorization: 'Bearer token' }),
          res,
          'proj-1',
          'thread-1',
          'msg-1',
          invalidBody,
        ),
      ).rejects.toThrow(BadRequestException);
    }

    // Valid empty body & explicit trimmed title succeed with Cache-Control: no-store
    const mockBranched = {
      id: 'thread-2',
      title: 'Architecture Q&A',
      isBranched: true,
      parentThreadId: 'thread-1',
      parentThreadTitle: 'Architecture Q&A',
      branchPointMessageId: 'msg-1',
      createdAt: '2026-10-31T10:00:00Z',
      updatedAt: '2026-10-31T10:00:00Z',
    };
    branchThreadMock.mockResolvedValueOnce(mockBranched);

    const out = await controller.branchThread(
      makeReq({
        cookie: 'continuum_access=jwt; __Host-csrf=csrf-ok',
        'x-csrf-token': 'csrf-ok',
      }),
      res,
      'proj-1',
      'thread-1',
      'msg-1',
      { title: '  Architecture Q&A  ' },
    );
    expect(headers['cache-control']).toBe('no-store');
    expect(branchThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cookie: 'continuum_access=jwt; __Host-csrf=csrf-ok',
        csrfToken: 'csrf-ok',
      }),
      'proj-1',
      'thread-1',
      'msg-1',
      { title: 'Architecture Q&A' },
    );
    expect(out).toEqual(mockBranched);
  });

  it('proxies Knowledge Universe overview, cluster, unit, and resolve endpoints with validation and CSRF enforcement', async () => {
    const {
      controller,
      getKnowledgeUniverseOverviewMock,
      getKnowledgeUniverseClusterMock,
      getKnowledgeUniverseUnitMock,
      resolveKnowledgeUniverseReferencesMock,
    } = setup();
    const { res, headers } = makeRes();

    getKnowledgeUniverseOverviewMock.mockResolvedValueOnce({
      total_trees: 1,
      total_nodes: 2,
      total_units: 10,
      trees: [],
    });

    const overview = await controller.getKnowledgeUniverseOverview(
      makeReq({ authorization: 'Bearer token' }),
      res,
      'proj-1',
    );
    expect(headers['cache-control']).toBe('no-store');
    expect(overview).toMatchObject({ total_trees: 1 });
    expect(getKnowledgeUniverseOverviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ authorization: 'Bearer token' }),
      'proj-1',
    );

    // Cluster query validation
    await expect(
      controller.getKnowledgeUniverseCluster(
        makeReq({ authorization: 'Bearer token' }),
        res,
        'proj-1',
        { tree_version: 'v1' }, // missing node_id
      ),
    ).rejects.toThrow(BadRequestException);

    getKnowledgeUniverseClusterMock.mockResolvedValueOnce({
      project_id: 'proj-1',
      tree_version: 'v1',
      node_id: 'root_1',
      total_units: 2,
      units: [],
      edges: [],
    });
    const cluster = await controller.getKnowledgeUniverseCluster(
      makeReq({ authorization: 'Bearer token' }),
      res,
      'proj-1',
      { tree_version: 'v1', node_id: 'root_1', limit: '50' },
    );
    expect(cluster).toMatchObject({ node_id: 'root_1' });
    expect(getKnowledgeUniverseClusterMock).toHaveBeenCalledWith(
      expect.objectContaining({ authorization: 'Bearer token' }),
      'proj-1',
      { treeVersion: 'v1', nodeId: 'root_1', limit: 50 },
    );

    // Unit detail
    getKnowledgeUniverseUnitMock.mockResolvedValueOnce({ id: 'unit:1' });
    const unit = await controller.getKnowledgeUniverseUnit(
      makeReq({ authorization: 'Bearer token' }),
      res,
      'proj-1',
      'unit:1',
      { tree_version: 'v1' },
    );
    expect(unit).toEqual({ id: 'unit:1' });
    expect(getKnowledgeUniverseUnitMock).toHaveBeenCalledWith(
      expect.objectContaining({ authorization: 'Bearer token' }),
      'proj-1',
      'unit:1',
      'v1',
    );

    // Resolve references requires CSRF on cookie auth
    await expect(
      controller.resolveKnowledgeUniverseReferences(
        makeReq({
          cookie: 'continuum_access=jwt; __Host-csrf=csrf-ok',
          'x-csrf-token': 'bad-csrf',
        }),
        res,
        'proj-1',
        { references: [{ source_id: 's1', search_unit_id: 'u1' }] },
      ),
    ).rejects.toThrow(ForbiddenException);

    resolveKnowledgeUniverseReferencesMock.mockResolvedValueOnce({
      total_resolved: 1,
      matches: [],
    });
    const resolved = await controller.resolveKnowledgeUniverseReferences(
      makeReq({
        cookie: 'continuum_access=jwt; __Host-csrf=csrf-ok',
        'x-csrf-token': 'csrf-ok',
      }),
      res,
      'proj-1',
      { references: [{ source_id: 's1', search_unit_id: 'u1' }] },
    );
    expect(resolved).toEqual({ total_resolved: 1, matches: [] });
    expect(resolveKnowledgeUniverseReferencesMock).toHaveBeenCalledWith(
      expect.objectContaining({ csrfToken: 'csrf-ok' }),
      'proj-1',
      [
        {
          source_id: 's1',
          search_unit_id: 'u1',
        },
      ],
    );
  });
});
