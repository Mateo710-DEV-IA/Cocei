import { IsNotEmpty, IsString } from 'class-validator';

export class CancelContractDto {
  @IsString()
  @IsNotEmpty()
  folio_digital: string;
}
