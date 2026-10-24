import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { Readable } from 'node:stream';
import { WorkNotesController } from './work-notes.controller';
import type { WorkNotesService } from '../application/work-notes.service';

describe('WorkNotesController CSRF enforcement', () => {
  const projectId = '507f1f77bcf86cd799439011';
  const taskId = '507f1f77bcf86cd799439012';
  const noteId = '507f1f77bcf86cd799439013';
  const documentId = '507f1f77bcf86cd799439014';
  const reportId = '507f1f77bcf86cd799439015';
  const csrfToken = 'csrf-token-value-123';

  let service: Record<string, jest.Mock>;
  let controller: WorkNotesController;

  beforeEach(() => {
    service = {
      uploadDocumentFile: jest.fn().mockResolvedValue({ id: documentId }),
      createTaskNote: jest.fn().mockResolvedValue({ id: noteId }),
      updateTaskNote: jest.fn().mockResolvedValue({ id: noteId }),
      deleteTaskNote: jest.fn().mockResolvedValue(undefined),
      createDocument: jest.fn().mockResolvedValue({ id: documentId }),
      updateDocumentDraft: jest.fn().mockResolvedValue({ id: documentId }),
      submitDocument: jest.fn().mockResolvedValue({ id: documentId }),
      reviewDocument: jest.fn().mockResolvedValue({ id: documentId }),
      archiveDocument: jest.fn().mockResolvedValue({ id: documentId }),
      updateWorkReportSettings: jest
        .fn()
        .mockResolvedValue({ frequency: 'DAILY' }),
      saveCurrentWorkReportDraft: jest.fn().mockResolvedValue({ id: reportId }),
      updateWorkReportDraft: jest.fn().mockResolvedValue({ id: reportId }),
      submitWorkReport: jest.fn().mockResolvedValue({ id: reportId }),
      reviewWorkReport: jest.fn().mockResolvedValue({ id: reportId }),
      listTaskNotes: jest.fn().mockResolvedValue({ data: [] }),
    };
    controller = new WorkNotesController(
      service as unknown as WorkNotesService,
    );
  });

  const makeRequest = (headers: Record<string, string>, body?: Buffer) => {
    const stream = Readable.from(body ? [body] : []);
    return Object.assign(stream, { headers }) as unknown as Request;
  };

  it('rejects cookie-authenticated mutations when x-csrf-token is missing or mismatched', async () => {
    const missingCsrfReq = makeRequest({
      cookie: `continuum_session=session-1; continuum_csrf=${csrfToken}`,
    });
    const mismatchedCsrfReq = makeRequest({
      cookie: `continuum_session=session-1; continuum_csrf=${csrfToken}`,
      'x-csrf-token': 'wrong-token',
    });

    const noteInput = {
      title: 'Note',
      accomplishments: 'Done',
      approach: 'Approach',
      reason: 'Reason',
    };
    const docInput = {
      title: 'Doc',
      type: 'ARCHITECTURE',
      content: 'Content',
    };
    const reportInput = {
      accomplishments: 'Done',
      approach: 'Approach',
      reason: 'Reason',
    };

    for (const req of [missingCsrfReq, mismatchedCsrfReq]) {
      expect(() =>
        controller.createTaskNote(req, projectId, taskId, noteInput),
      ).toThrow(ForbiddenException);
      expect(() =>
        controller.updateTaskNote(req, projectId, taskId, noteId, noteInput),
      ).toThrow(ForbiddenException);
      expect(() =>
        controller.deleteTaskNote(req, projectId, taskId, noteId),
      ).toThrow(ForbiddenException);
      expect(() => controller.createDocument(req, projectId, docInput)).toThrow(
        ForbiddenException,
      );
      expect(() =>
        controller.updateDocumentDraft(req, projectId, documentId, docInput),
      ).toThrow(ForbiddenException);
      expect(() =>
        controller.submitDocument(req, projectId, documentId),
      ).toThrow(ForbiddenException);
      expect(() =>
        controller.approveDocument(req, projectId, documentId, {}),
      ).toThrow(ForbiddenException);
      expect(() =>
        controller.requestDocumentChanges(req, projectId, documentId, {
          comment: 'Fix',
        }),
      ).toThrow(ForbiddenException);
      expect(() =>
        controller.rejectDocument(req, projectId, documentId, {
          comment: 'No',
        }),
      ).toThrow(ForbiddenException);
      expect(() =>
        controller.archiveDocument(req, projectId, documentId),
      ).toThrow(ForbiddenException);
      expect(() =>
        controller.updateWorkReportSettings(req, projectId, {
          frequency: 'DAILY',
        }),
      ).toThrow(ForbiddenException);
      expect(() =>
        controller.saveCurrentWorkReportDraft(req, projectId, reportInput),
      ).toThrow(ForbiddenException);
      expect(() =>
        controller.updateWorkReportDraft(req, projectId, reportId, reportInput),
      ).toThrow(ForbiddenException);
      expect(() =>
        controller.submitWorkReport(req, projectId, reportId),
      ).toThrow(ForbiddenException);
      expect(() =>
        controller.approveWorkReport(req, projectId, reportId, {}),
      ).toThrow(ForbiddenException);
      expect(() =>
        controller.requestWorkReportChanges(req, projectId, reportId, {
          comment: 'More detail',
        }),
      ).toThrow(ForbiddenException);
      expect(() =>
        controller.rejectWorkReport(req, projectId, reportId, {
          comment: 'Invalid',
        }),
      ).toThrow(ForbiddenException);
      await expect(
        controller.uploadDocumentFile(req, projectId, documentId),
      ).rejects.toMatchObject({
        response: { code: 'CSRF_INVALID' },
      });
    }

    expect(service.createTaskNote).not.toHaveBeenCalled();
    expect(service.uploadDocumentFile).not.toHaveBeenCalled();
  });

  it('allows cookie-authenticated mutations with matching x-csrf-token and Bearer-authenticated mutations without CSRF', async () => {
    const validCookieReq = makeRequest(
      {
        cookie: `__Host-session=session-1; __Host-csrf=${csrfToken}`,
        'x-csrf-token': csrfToken,
        'x-file-name': 'spec.pdf',
        'content-type': 'application/pdf',
      },
      Buffer.from('%PDF-1.4'),
    );
    await controller.createTaskNote(validCookieReq, projectId, taskId, {
      title: 'Note',
      accomplishments: 'Done',
      approach: 'Approach',
      reason: 'Reason',
    });
    await controller.uploadDocumentFile(validCookieReq, projectId, documentId);
    expect(service.createTaskNote).toHaveBeenCalledTimes(1);
    expect(service.uploadDocumentFile).toHaveBeenCalledTimes(1);

    const bearerReq = makeRequest({
      authorization: 'Bearer access-token-123',
      cookie: 'continuum_session=session-1',
    });
    await controller.createDocument(bearerReq, projectId, {
      title: 'Doc',
      type: 'ARCHITECTURE',
      content: 'Content',
    });
    expect(service.createDocument).toHaveBeenCalledTimes(1);
  });
});
