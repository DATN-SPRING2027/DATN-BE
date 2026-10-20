import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

/** Cursor pagination only (DR-6): no page, total, filter or sort parameter. */
export class ListTasksQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Matches(/^[a-fA-F0-9]{24}$/, {
    message: 'afterId must be a 24-character hexadecimal id',
  })
  afterId?: string;
}
