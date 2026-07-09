import { IsArray, IsOptional, IsString } from 'class-validator';

export class DownloadTraceabilityDto {
  @IsOptional()
  @IsString()
  folio_digital?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  folios?: string[];
}
