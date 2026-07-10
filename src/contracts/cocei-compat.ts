import { BadRequestException } from '@nestjs/common';

type UploadedPdfFields = {
  file?: Express.Multer.File[];
  pdf_file?: Express.Multer.File[];
};

export function readFolioDigital(body: Record<string, unknown>): string {
  const value = body?.folio_digital;
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  throw new BadRequestException('folio_digital es requerido');
}

export function pickUploadedPdf(
  files: UploadedPdfFields,
): Express.Multer.File | undefined {
  return files.file?.[0] ?? files.pdf_file?.[0];
}

export function isPdfUpload(file: {
  mimetype: string;
  originalname?: string;
}): boolean {
  if (file.mimetype === 'application/pdf') {
    return true;
  }
  return /\.pdf$/i.test(file.originalname || '');
}

export function buildUploadPdfResponse(params: {
  folioDigital: string;
  folderId: string;
  file: { fileId: string; webViewLink: string; name: string };
}) {
  return {
    message: 'PDF cargado correctamente',
    folio_digital: params.folioDigital,
    folderId: params.folderId,
    id_drive: params.folderId,
    file: params.file,
  };
}
