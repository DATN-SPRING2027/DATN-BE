import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../../config/runtime-config.module';
import { AccessTokenService } from './application/authentication/access-token.service';
import { AUTH_SECURITY_STORE } from './application/authentication/auth-security.store';
import { AuthenticationApplicationService } from './application/authentication/authentication.application.service';
import { PasswordResetOutboxWorker } from './infrastructure/email/password-reset-outbox.worker';
import { PASSWORD_RESET_MAILER } from './application/authentication/password-reset.mailer';
import { PasswordResetService } from './application/authentication/password-reset.service';
import { GoogleOAuthService } from './application/authentication/google-oauth.service';
import { AUTHENTICATION_REPOSITORY } from './application/authentication/authentication.repository';
import { LeaderDirectedLoginEligibilityPolicy } from './application/authentication/leader-directed-login-eligibility.policy';
import { LOGIN_ELIGIBILITY_POLICY } from './application/authentication/login-eligibility.policy';
import { MembershipOrganizationContextResolver } from './application/authentication/membership-organization-context.resolver';
import { ORGANIZATION_CONTEXT_RESOLVER } from './application/authentication/organization-context.resolver';
import { PasswordCredentialService } from './application/credentials/password-credential.service';
import { AUTHORIZATION_EVIDENCE_PROVIDER } from './application/authorization/authorization-evidence.provider';
import { AuthorizationPolicy } from './application/authorization/authorization.policy';
import { ProjectCreateAuthorizationGuard } from './application/authorization/project-create-authorization.guard';
import { PlatformAuthorizationGuard } from './application/authorization/platform-authorization.guard';
import { IamApplicationService } from './application/iam.service';
import { AuthenticationController } from './controllers/authentication.controller';
import { IamController } from './controllers/iam.controller';
import { IamInfrastructureModule } from './infrastructure/iam.infrastructure.module';
import { AuthenticationRepository } from './infrastructure/mongodb/authentication.repository';
import { UserDirectoryController } from './controllers/user-directory.controller';
import { OrganizationMembershipReadController } from './controllers/organization-membership-read.controller';
import { OrganizationMembershipReadService } from './application/organizations/organization-membership-read.service';
import { ORGANIZATION_MEMBERSHIP_READ_REPOSITORY } from './application/organizations/organization-membership-read.repository';
import { MongoOrganizationMembershipReadRepository } from './infrastructure/mongodb/organization-membership-read.repository';
import { UserDirectoryService } from './application/users/user-directory.service';
import { USER_DIRECTORY_REPOSITORY } from './application/users/user-directory.repository';
import { MongoUserDirectoryRepository } from './infrastructure/mongodb/user-directory.repository';
import { MongoAuthorizationEvidenceProvider } from './infrastructure/mongodb/authorization-evidence.provider';
import { RedisService } from './infrastructure/redis/redis.service';
import { SmtpPasswordResetMailer } from './infrastructure/email/smtp-password-reset.mailer';
import { ProjectController } from './controllers/project.controller';
import { ProjectAccessController } from './controllers/project-access.controller';
import { ProjectService } from './application/projects/project.service';
import { PROJECT_REPOSITORY } from './application/projects/project.repository';
import { MongoProjectRepository } from './infrastructure/mongodb/project.repository';
import { ProjectAccessAuthorizationGuard } from './application/authorization/project-access-authorization.guard';
import { ProjectAccessService } from './application/projects/project-access.service';
import { PROJECT_ACCESS_REPOSITORY } from './application/projects/project-access.repository';
import { MongoProjectAccessRepository } from './infrastructure/mongodb/project-access.repository';
import { PlatformController } from './controllers/platform.controller';
import { AccountOrganizationController } from './controllers/account-organization.controller';
import { OrganizationProvisioningService } from './application/organizations/organization-provisioning.service';
import { ORGANIZATION_PROVISIONING_REPOSITORY } from './application/organizations/organization-provisioning.repository';
import { MongoOrganizationProvisioningRepository } from './infrastructure/mongodb/organization-provisioning.repository';
import { PlatformAuditService } from './application/platform/platform-audit.service';
import { PLATFORM_AUDIT_REPOSITORY } from './application/platform/platform-audit.repository';
import { MongoPlatformAuditRepository } from './infrastructure/mongodb/platform-audit.repository';
import {
  OrganizationInvitationController,
  AccountInvitationController,
} from './controllers/organization-invitation.controller';
import { OrganizationInvitationService } from './application/organizations/organization-invitation.service';
import { ORGANIZATION_INVITATION_REPOSITORY } from './application/organizations/organization-invitation.repository';
import { MongoOrganizationInvitationRepository } from './infrastructure/mongodb/organization-invitation.repository';

@Module({
  imports: [RuntimeConfigModule, IamInfrastructureModule.register()],
  controllers: [
    IamController,
    AuthenticationController,
    UserDirectoryController,
    OrganizationMembershipReadController,
    ProjectController,
    ProjectAccessController,
    PlatformController,
    AccountOrganizationController,
    OrganizationInvitationController,
    AccountInvitationController,
  ],
  providers: [
    IamApplicationService,
    AccessTokenService,
    AuthenticationApplicationService,
    PasswordResetService,
    GoogleOAuthService,
    { provide: AUTH_SECURITY_STORE, useExisting: RedisService },
    { provide: PASSWORD_RESET_MAILER, useClass: SmtpPasswordResetMailer },
    ...(process.env.INFRA_ENABLED === 'true'
      ? [PasswordResetOutboxWorker]
      : []),
    LeaderDirectedLoginEligibilityPolicy,
    MembershipOrganizationContextResolver,
    {
      provide: LOGIN_ELIGIBILITY_POLICY,
      useExisting: LeaderDirectedLoginEligibilityPolicy,
    },
    {
      provide: ORGANIZATION_CONTEXT_RESOLVER,
      useExisting: MembershipOrganizationContextResolver,
    },
    {
      provide: AUTHENTICATION_REPOSITORY,
      useClass: AuthenticationRepository,
    },
    PasswordCredentialService,
    AuthorizationPolicy,
    ProjectCreateAuthorizationGuard,
    ProjectAccessAuthorizationGuard,
    PlatformAuthorizationGuard,
    {
      provide: AUTHORIZATION_EVIDENCE_PROVIDER,
      useClass: MongoAuthorizationEvidenceProvider,
    },
    UserDirectoryService,
    OrganizationMembershipReadService,
    ProjectService,
    ProjectAccessService,
    OrganizationProvisioningService,
    OrganizationInvitationService,
    PlatformAuditService,
    { provide: PROJECT_REPOSITORY, useClass: MongoProjectRepository },
    {
      provide: ORGANIZATION_MEMBERSHIP_READ_REPOSITORY,
      useClass: MongoOrganizationMembershipReadRepository,
    },
    {
      provide: PROJECT_ACCESS_REPOSITORY,
      useClass: MongoProjectAccessRepository,
    },
    {
      provide: USER_DIRECTORY_REPOSITORY,
      useClass: MongoUserDirectoryRepository,
    },
    {
      provide: ORGANIZATION_PROVISIONING_REPOSITORY,
      useClass: MongoOrganizationProvisioningRepository,
    },
    {
      provide: ORGANIZATION_INVITATION_REPOSITORY,
      useClass: MongoOrganizationInvitationRepository,
    },
    {
      provide: PLATFORM_AUDIT_REPOSITORY,
      useClass: MongoPlatformAuditRepository,
    },
  ],
})
export class IamModule {}
