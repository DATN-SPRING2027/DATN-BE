import {
  IsEmail,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class LoginCredentialsDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  password!: string;
}

export class LoginRequestDto extends LoginCredentialsDto {
  @IsOptional()
  @IsMongoId()
  organizationId?: string;
}

export class PlatformLoginRequestDto extends LoginCredentialsDto {}
