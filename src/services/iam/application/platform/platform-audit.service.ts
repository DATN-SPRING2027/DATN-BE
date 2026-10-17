import { Inject, Injectable } from '@nestjs/common';
import {
  PLATFORM_AUDIT_REPOSITORY,
  type PlatformAuditRepository,
} from './platform-audit.repository';

@Injectable()
export class PlatformAuditService {
  constructor(
    @Inject(PLATFORM_AUDIT_REPOSITORY)
    private readonly repository: PlatformAuditRepository,
  ) {}

  listOperationalMetadata() {
    return this.repository.listOperationalMetadata();
  }
}
