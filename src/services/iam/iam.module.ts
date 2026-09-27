import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../../config/runtime-config.module';
import { AccessTokenService } from './application/authentication/access-token.service';
import { AUTH_SECURITY_STORE } from './application/authentication/auth-security.store';
import { AuthenticationApplicationService } from './application/authentication/authentication.application.service';
import { AUTHENTICATION_REPOSITORY } from './application/authentication/authentication.repository';
import { LeaderDirectedLoginEligibilityPolicy } from './application/authentication/leader-directed-login-eligibility.policy';
import { LOGIN_ELIGIBILITY_POLICY } from './application/authentication/login-eligibility.policy';
import { RoleAssignmentOrganizationContextResolver } from './application/authentication/role-assignment-organization-context.resolver';
import { ORGANIZATION_CONTEXT_RESOLVER } from './application/authentication/organization-context.resolver';
import { PasswordCredentialService } from './application/credentials/password-credential.service';
import { IamApplicationService } from './application/iam.service';
import { AuthenticationController } from './controllers/authentication.controller';
import { IamController } from './controllers/iam.controller';
import { IamInfrastructureModule } from './infrastructure/iam.infrastructure.module';
import { AuthenticationRepository } from './infrastructure/mongodb/authentication.repository';
import { UserCredentialRepository } from './infrastructure/mongodb/user-credential.repository';
import { UserDirectoryController } from './controllers/user-directory.controller';
import { UserDirectoryService } from './application/users/user-directory.service';
import { USER_DIRECTORY_REPOSITORY } from './application/users/user-directory.repository';
import { MongoUserDirectoryRepository } from './infrastructure/mongodb/user-directory.repository';
import { RedisService } from './infrastructure/redis/redis.service';

@Module({
  imports: [RuntimeConfigModule, IamInfrastructureModule.register()],
  controllers: [
    IamController,
    AuthenticationController,
    UserDirectoryController,
  ],
  providers: [
    IamApplicationService,
    AccessTokenService,
    AuthenticationApplicationService,
    { provide: AUTH_SECURITY_STORE, useExisting: RedisService },
    LeaderDirectedLoginEligibilityPolicy,
    RoleAssignmentOrganizationContextResolver,
    {
      provide: LOGIN_ELIGIBILITY_POLICY,
      useExisting: LeaderDirectedLoginEligibilityPolicy,
    },
    {
      provide: ORGANIZATION_CONTEXT_RESOLVER,
      useExisting: RoleAssignmentOrganizationContextResolver,
    },
    {
      provide: AUTHENTICATION_REPOSITORY,
      useClass: AuthenticationRepository,
    },
    PasswordCredentialService,
    UserCredentialRepository,
    UserDirectoryService,
    {
      provide: USER_DIRECTORY_REPOSITORY,
      useClass: MongoUserDirectoryRepository,
    },
  ],
})
export class IamModule {}
