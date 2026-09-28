import {
  IsEmail,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class LoginRequestDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  password!: string;

  @IsOptional()
  @IsMongoId()
  organizationId?: string;
}
