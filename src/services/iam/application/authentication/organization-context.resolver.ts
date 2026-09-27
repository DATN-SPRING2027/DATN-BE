import { Injectable } from '@nestjs/common';

export const ORGANIZATION_CONTEXT_RESOLVER = Symbol(
  'ORGANIZATION_CONTEXT_RESOLVER',
);

export interface ResolvedOrganizationContext {
  orgId: string;
  roles: string[];
}

export type OrganizationContextResolution =
  | { outcome: 'RESOLVED'; context: ResolvedOrganizationContext }
  | { outcome: 'NO_ELIGIBLE_ORGANIZATION' }
  | { outcome: 'ORGANIZATION_SELECTION_REQUIRED' }
  | { outcome: 'INVALID_ORGANIZATION_SELECTION' }
  | { outcome: 'DECISION_REQUIRED'; gates: readonly ['G-01', 'G-02'] };

export interface OrganizationContextResolver {
  resolveForUser(
    userId: string,
    organizationId?: string,
  ): Promise<OrganizationContextResolution>;
}

/** Fail-closed adapter; it deliberately does not inspect request input or assignments. */
@Injectable()
export class DecisionRequiredOrganizationContextResolver implements OrganizationContextResolver {
  resolveForUser(userId: string): Promise<OrganizationContextResolution> {
    void userId;
    return Promise.resolve({
      outcome: 'DECISION_REQUIRED',
      gates: ['G-01', 'G-02'],
    });
  }
}
