import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CancelContractDto {
  @IsString()
  @IsNotEmpty()
  folio_digital: string;

  @IsOptional()
  @IsString()
  motivo_cancelacion?: string;
}
