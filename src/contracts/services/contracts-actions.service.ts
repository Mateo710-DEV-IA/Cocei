import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
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
  private readonly logger = new Logger(ContractsActionsService.name);

  constructor(
    private readonly googleService: GoogleWorkspaceService,
    private readonly processService: ContractProcessService,
    private readonly configService: ConfigService,
  ) {}

  async uploadPdf(
    body: Record<string, unknown>,
    files: UploadedPdfFields,
    routeLabel = 'upload-pdf',
  ) {
    const bodyKeys = Object.keys(body || {});
    const hasFile = Boolean(files?.file?.[0]);
    const hasPdfFile = Boolean(files?.pdf_file?.[0]);
    this.logger.log(
      `[ENDPOINT_IN] route=${routeLabel} action=upload bodyKeys=${bodyKeys.join(',') || '(none)'} has_file=${hasFile} has_pdf_file=${hasPdfFile}`,
    );

    try {
      const file = pickUploadedPdf(files);
      if (!file) {
        this.logger.warn(
          `[ENDPOINT_STOP] route=${routeLabel} action=upload reason=sin_archivo_pdf campos_esperados=file|pdf_file`,
        );
        throw new BadRequestException(
          'Debes enviar el archivo PDF en campo "file" o "pdf_file"',
        );
      }

      let folioDigital: string;
      try {
        folioDigital = readFolioDigital(body);
      } catch (error) {
        this.logger.warn(
          `[ENDPOINT_STOP] route=${routeLabel} action=upload reason=folio_digital_requerido bodyKeys=${bodyKeys.join(',')}`,
        );
        throw error;
      }

      this.logger.log(
        `[ENDPOINT_STEP] route=${routeLabel} action=upload folio=${folioDigital} fileName=${file.originalname || '(sin_nombre)'} size=${file.size || 0}`,
      );

      const parentFolderId =
        this.configService.get<string>('GOOGLE_DRIVE_PARENT_FOLDER_ID') ||
        undefined;
      const folderId = await this.googleService.createFolder(
        folioDigital,
        parentFolderId,
      );
      this.logger.log(
        `[ENDPOINT_STEP] route=${routeLabel} action=upload folio=${folioDigital} folderId=${folderId}`,
      );

      const upload = await this.googleService.uploadPdf({
        folderId,
        fileName: file.originalname || `${folioDigital}.pdf`,
        pdfBuffer: file.buffer,
      });

      const response = buildUploadPdfResponse({
        folioDigital,
        folderId,
        file: upload,
      });

      this.logger.log(
        `[ENDPOINT_OK] route=${routeLabel} action=upload folio=${folioDigital} id_drive=${response.id_drive} fileId=${upload.fileId}`,
      );
      return response;
    } catch (error) {
      this.logger.error(
        `[ENDPOINT_FAIL] route=${routeLabel} action=upload reason=${(error as Error).message}`,
      );
      throw error;
    }
  }

  async processContract(req: Request, routeLabel = 'process') {
    const body = (req.body || {}) as Record<string, unknown>;
    const bodyKeys = Object.keys(body);
    this.logger.log(
      `[ENDPOINT_IN] route=${routeLabel} action=process method=${req.method} contentType=${req.headers['content-type'] || '(none)'} bodyKeys=${bodyKeys.join(',') || '(none)'}`,
    );

    try {
      let folioDigital: string;
      try {
        folioDigital = readFolioDigital(body);
      } catch (error) {
        this.logger.warn(
          `[ENDPOINT_STOP] route=${routeLabel} action=process reason=folio_digital_requerido body=${JSON.stringify(body).slice(0, 300)}`,
        );
        throw error;
      }

      this.logger.log(
        `[ENDPOINT_STEP] route=${routeLabel} action=process folio=${folioDigital} consultando_sql_y_generando_OT_OS`,
      );
      const result = await this.processService.processByFolio(folioDigital);
      this.logger.log(
        `[ENDPOINT_OK] route=${routeLabel} action=process folio=${folioDigital} cancelled=${Boolean((result as { cancelled?: boolean }).cancelled)}`,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `[ENDPOINT_FAIL] route=${routeLabel} action=process reason=${(error as Error).message}`,
      );
      throw error;
    }
  }

  async cancelContract(req: Request, routeLabel = 'cancel') {
    const body = (req.body || {}) as Record<string, unknown>;
    const bodyKeys = Object.keys(body);
    this.logger.log(
      `[ENDPOINT_IN] route=${routeLabel} action=cancel method=${req.method} bodyKeys=${bodyKeys.join(',') || '(none)'}`,
    );

    try {
      let folioDigital: string;
      try {
        folioDigital = readFolioDigital(body);
      } catch (error) {
        this.logger.warn(
          `[ENDPOINT_STOP] route=${routeLabel} action=cancel reason=folio_digital_requerido`,
        );
        throw error;
      }

      this.logger.log(
        `[ENDPOINT_STEP] route=${routeLabel} action=cancel folio=${folioDigital}`,
      );
      const result = await this.processService.cancelByFolio(folioDigital);
      this.logger.log(
        `[ENDPOINT_OK] route=${routeLabel} action=cancel folio=${folioDigital}`,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `[ENDPOINT_FAIL] route=${routeLabel} action=cancel reason=${(error as Error).message}`,
      );
      throw error;
    }
  }

  async downloadTraceability(
    req: Request,
    res: Response,
    routeLabel = 'traceability/download',
  ) {
    const body = (req.body || {}) as Record<string, unknown>;
    const bodyKeys = Object.keys(body);
    this.logger.log(
      `[ENDPOINT_IN] route=${routeLabel} action=traceability method=${req.method} bodyKeys=${bodyKeys.join(',') || '(none)'}`,
    );

    try {
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
        this.logger.warn(
          `[ENDPOINT_STOP] route=${routeLabel} action=traceability reason=sin_folios`,
        );
        throw new BadRequestException(
          'Debes enviar folio_digital o folios para descargar trazabilidad.',
        );
      }

      this.logger.log(
        `[ENDPOINT_STEP] route=${routeLabel} action=traceability folios=${folios.join(',')}`,
      );
      const result = await this.processService.buildTraceabilityZipByFolios({
        folios,
      });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${result.fileName}"`,
      );
      if (result.missingFolios.length) {
        res.setHeader('X-Missing-Folios', result.missingFolios.join(','));
        this.logger.warn(
          `[ENDPOINT_WARN] route=${routeLabel} action=traceability missingFolios=${result.missingFolios.join(',')}`,
        );
      }
      res.status(200).send(result.zipBuffer);
      this.logger.log(
        `[ENDPOINT_OK] route=${routeLabel} action=traceability fileName=${result.fileName} bytes=${result.zipBuffer.length}`,
      );
    } catch (error) {
      this.logger.error(
        `[ENDPOINT_FAIL] route=${routeLabel} action=traceability reason=${(error as Error).message}`,
      );
      throw error;
    }
  }
}
