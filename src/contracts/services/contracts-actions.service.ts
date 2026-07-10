import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import {
  buildUploadPdfResponse,
  pickUploadedPdf,
  readFolioDigital,
} from '../cocei-compat';
import { GoogleWorkspaceService } from './google-workspace.service';
import { ContractProcessService } from './contract-process.service';

type UploadedPdfFields = {
  file?: Express.Multer.File[];
  pdf_file?: Express.Multer.File[];
};

@Injectable()
export class ContractsActionsService {
  constructor(
    private readonly googleService: GoogleWorkspaceService,
    private readonly processService: ContractProcessService,
    private readonly configService: ConfigService,
  ) {}

  async uploadPdf(
    body: Record<string, unknown>,
    files: UploadedPdfFields,
  ) {
    const file = pickUploadedPdf(files);
    if (!file) {
      throw new BadRequestException(
        'Debes enviar el archivo PDF en campo "file" o "pdf_file"',
      );
    }

    const folioDigital = readFolioDigital(body);
    const parentFolderId =
      this.configService.get<string>('GOOGLE_DRIVE_PARENT_FOLDER_ID') || undefined;
    const folderId = await this.googleService.createFolder(
      folioDigital,
      parentFolderId,
    );

    const upload = await this.googleService.uploadPdf({
      folderId,
      fileName: file.originalname || `${folioDigital}.pdf`,
      pdfBuffer: file.buffer,
    });

    return buildUploadPdfResponse({
      folioDigital,
      folderId,
      file: upload,
    });
  }

  async processContract(req: Request) {
    const folioDigital = readFolioDigital(req.body as Record<string, unknown>);
    return this.processService.processByFolio(folioDigital);
  }

  async cancelContract(req: Request) {
    const folioDigital = readFolioDigital(req.body as Record<string, unknown>);
    return this.processService.cancelByFolio(folioDigital);
  }

  async downloadTraceability(req: Request, res: Response) {
    const body = req.body as Record<string, unknown>;
    const folioDigital =
      typeof body.folio_digital === 'string' ? body.folio_digital.trim() : '';
    const foliosInput = Array.isArray(body.folios) ? body.folios : [];

    const folios = Array.from(
      new Set(
        [folioDigital, ...foliosInput]
          .map((item) => String(item || '').trim())
          .filter((item) => item.length > 0),
      ),
    );

    if (!folios.length) {
      throw new BadRequestException(
        'Debes enviar folio_digital o folios para descargar trazabilidad.',
      );
    }

    const result = await this.processService.buildTraceabilityZipByFolios({ folios });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.fileName}"`,
    );
    if (result.missingFolios.length) {
      res.setHeader('X-Missing-Folios', result.missingFolios.join(','));
    }
    res.send(result.zipBuffer);
  }
}
