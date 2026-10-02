import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../../config/runtime-config.module';
import { AccessTokenService } from './application/authentication/access-token.service';
import { AUTH_SECURITY_STORE } from './application/authentication/auth-security.store';
import { AuthenticationApplicationService } from './application/authentication/authentication.application.service';
import { AUTHENTICATION_REPOSITORY } from './application/authentication/authentication.repository';
import { LeaderDirectedLoginEligibilityPolicy } from './application/authentication/leader-directed-login-eligibility.policy';
import { LOGIN_ELIGIBILITY_POLICY } from './application/authentication/login-eligibility.policy';
import { MembershipOrganizationContextResolver } from './application/authentication/membership-organization-context.resolver';
import { ORGANIZATION_CONTEXT_RESOLVER } from './application/authentication/organization-context.resolver';
import { PasswordCredentialService } from './application/credentials/password-credential.service';
import { AUTHORIZATION_EVIDENCE_PROVIDER } from './application/authorization/authorization-evidence.provider';
import { AuthorizationPolicy } from './application/authorization/authorization.policy';
import { ProjectCreateAuthorizationGuard } from './application/authorization/project-create-authorization.guard';
import { IamApplicationService } from './application/iam.service';
import { AuthenticationController } from './controllers/authentication.controller';
import { IamController } from './controllers/iam.controller';
import { IamInfrastructureModule } from './infrastructure/iam.infrastructure.module';
import { AuthenticationRepository } from './infrastructure/mongodb/authentication.repository';
import { UserDirectoryController } from './controllers/user-directory.controller';
import { UserDirectoryService } from './application/users/user-directory.service';
import { USER_DIRECTORY_REPOSITORY } from './application/users/user-directory.repository';
import { MongoUserDirectoryRepository } from './infrastructure/mongodb/user-directory.repository';
import { MongoAuthorizationEvidenceProvider } from './infrastructure/mongodb/authorization-evidence.provider';
import { RedisService } from './infrastructure/redis/redis.service';
import { ProjectController } from './controllers/project.controller';
import { ProjectAccessController } from './controllers/project-access.controller';
import { ProjectService } from './application/projects/project.service';
import { PROJECT_REPOSITORY } from './application/projects/project.repository';
import { MongoProjectRepository } from './infrastructure/mongodb/project.repository';
import { ProjectAccessAuthorizationGuard } from './application/authorization/project-access-authorization.guard';
import { ProjectAccessService } from './application/projects/project-access.service';
import { PROJECT_ACCESS_REPOSITORY } from './application/projects/project-access.repository';
import { MongoProjectAccessRepository } from './infrastructure/mongodb/project-access.repository';

@Module({
  imports: [RuntimeConfigModule, IamInfrastructureModule.register()],
  controllers: [
    IamController,
    AuthenticationController,
    UserDirectoryController,
    ProjectController,
    ProjectAccessController,
  ],
  providers: [
    IamApplicationService,
    AccessTokenService,
    AuthenticationApplicationService,
    { provide: AUTH_SECURITY_STORE, useExisting: RedisService },
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
    {
      provide: AUTHORIZATION_EVIDENCE_PROVIDER,
      useClass: MongoAuthorizationEvidenceProvider,
    },
    UserDirectoryService,
    ProjectService,
    ProjectAccessService,
    { provide: PROJECT_REPOSITORY, useClass: MongoProjectRepository },
    {
      provide: PROJECT_ACCESS_REPOSITORY,
      useClass: MongoProjectAccessRepository,
    },
    {
      provide: USER_DIRECTORY_REPOSITORY,
      useClass: MongoUserDirectoryRepository,
    },
  ],
})
export class IamModule {}
