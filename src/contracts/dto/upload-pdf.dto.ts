import { IsNotEmpty, IsString } from 'class-validator';

export class UploadPdfDto {
  @IsString()
  @IsNotEmpty()
  folio_digital: string;
}
