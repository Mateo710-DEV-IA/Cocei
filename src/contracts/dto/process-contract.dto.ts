import { IsNotEmpty, IsString } from 'class-validator';

export class ProcessContractDto {
  @IsString()
  @IsNotEmpty()
  folio_digital: string;
}
