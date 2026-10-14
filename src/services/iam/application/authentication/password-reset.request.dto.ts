import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class PasswordResetRequestDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

export class PasswordResetConfirmDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(72)
  password!: string;
}
