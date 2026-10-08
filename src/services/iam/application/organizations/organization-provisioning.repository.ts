export const ORGANIZATION_PROVISIONING_REPOSITORY = Symbol(
  'ORGANIZATION_PROVISIONING_REPOSITORY',
);

export type OrganizationPlan = 'FREE' | 'ENTERPRISE';

export interface OrganizationProvisioningInput {
  name: string;
  slug: string;
  plan: OrganizationPlan;
  firstAdminUserId: string;
}

export interface ProvisionedOrganization {
  id: string;
  name: string;
  slug: string;
  plan: OrganizationPlan;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationProvisioningRepository {
  create(
    actorUserId: string,
    input: OrganizationProvisioningInput,
  ): Promise<ProvisionedOrganization>;
}
