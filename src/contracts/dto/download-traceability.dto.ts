import { IsArray, IsOptional, IsString } from 'class-validator';

/**
 * Contratos aceptados por el endpoint (parseo manual en ContractsActionsService):
 * - [{ folio_digital: "..." }, ...]
 * - { folio_digital: "..." }
 * - { folios: ["...", ...] }
 * - { folios: [{ folio_digital: "..." }, ...] }
 */
export class DownloadTraceabilityDto {
  @IsOptional()
  @IsString()
  folio_digital?: string;

  @IsOptional()
  @IsArray()
  folios?: Array<string | { folio_digital: string }>;
}
