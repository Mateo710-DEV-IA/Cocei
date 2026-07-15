import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { SystemErrorService } from '../../common/system-error.service';
import {
  buildUploadPdfResponse,
  pickUploadedPdf,
  readFolioDigital,
} from '../cocei-compat';
import { GoogleWorkspaceService } from './google-workspace.service';
import { ContractProcessService } from './contract-process.service';
import { SqlService } from './sql.service';

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
    private readonly sqlService: SqlService,
    private readonly systemErrorService: SystemErrorService,
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

      // Validación rápida (SQL): si el folio no existe, PHP recibe 4xx.
      // PHP en start_process solo exige HTTP 2xx; no parsea el body.
      const data = await this.sqlService.getContractByFolio(folioDigital);
      if (Number(data.contrato.is_cancelado || 0) === 1) {
        const cancelled = {
          ok: true,
          folio_digital: folioDigital,
          id_contrato: data.contrato.id_contrato,
          cancelled: true,
          status: 'cancelled',
          message:
            'El proceso ya fue cancelado para este folio. No se generan OT/OS ni nuevos envios.',
        };
        this.logger.log(
          `[ENDPOINT_OK] route=${routeLabel} action=process folio=${folioDigital} cancelled=true`,
        );
        return cancelled;
      }

      this.logger.log(
        `[ENDPOINT_STEP] route=${routeLabel} action=process folio=${folioDigital} accepted_background_OT_OS`,
      );

      // Respuesta inmediata (HTTP 200) para no romper CURLOPT_TIMEOUT=30 de PHP.
      // OT/OS corre en background; fallos → logs + tab_errores.
      void this.processService
        .processByFolio(folioDigital)
        .then((result) => {
          this.logger.log(
            `[ENDPOINT_OK] route=${routeLabel} action=process folio=${folioDigital} mode=background cancelled=${Boolean((result as { cancelled?: boolean }).cancelled)}`,
          );
        })
        .catch(async (error: unknown) => {
          const message = (error as Error)?.message || String(error);
          this.logger.error(
            `[ENDPOINT_FAIL] route=${routeLabel} action=process folio=${folioDigital} mode=background reason=${message}`,
          );
          await this.systemErrorService.notify({
            error,
            folioDigital,
            context: `processContract background route=${routeLabel}`,
            source: 'contracts-actions.process',
          });
        });

      return {
        ok: true,
        folio_digital: folioDigital,
        id_contrato: data.contrato.id_contrato,
        status: 'accepted',
        message: 'Proceso de automatizacion iniciado',
      };
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
    const body = req.body as unknown;
    const bodyKeys = Array.isArray(body)
      ? [`[array:${body.length}]`]
      : Object.keys((body as Record<string, unknown>) || {});
    this.logger.log(
      `[ENDPOINT_IN] route=${routeLabel} action=traceability method=${req.method} bodyKeys=${bodyKeys.join(',') || '(none)'}`,
    );

    try {
      const folios = this.parseTraceabilityFolios(body);

      if (!folios.length) {
        this.logger.warn(
          `[ENDPOINT_STOP] route=${routeLabel} action=traceability reason=sin_folios`,
        );
        throw new BadRequestException(
          'Debes enviar folio_digital, folios, o un arreglo [{ folio_digital }] para descargar trazabilidad.',
        );
      }

      this.logger.log(
        `[ENDPOINT_STEP] route=${routeLabel} action=traceability folios=${folios.join(',')}`,
      );
      const result = await this.processService.buildTraceabilityRarByFolios({
        folios,
      });
      res.setHeader('Content-Type', 'application/vnd.rar');
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
      res.status(200).send(result.rarBuffer);
      this.logger.log(
        `[ENDPOINT_OK] route=${routeLabel} action=traceability fileName=${result.fileName} bytes=${result.rarBuffer.length}`,
      );
    } catch (error) {
      this.logger.error(
        `[ENDPOINT_FAIL] route=${routeLabel} action=traceability reason=${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Acepta:
   * - [{ "folio_digital": "..." }, ...]
   * - { "body": [{ "folio_digital": "..." }, ...] }
   * - { "folio_digital": "..." }
   * - { "folios": ["...", ...] }
   * - { "folios": [{ "folio_digital": "..." }, ...] }
   * - JSON string en cualquiera de esos contenedores (PHP form)
   */
  private parseTraceabilityFolios(body: unknown): string[] {
    const collected: string[] = [];

    const pushFolio = (value: unknown) => {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
          return;
        }
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          try {
            this.collectTraceabilityFolios(JSON.parse(trimmed), collected);
          } catch {
            collected.push(trimmed);
          }
          return;
        }
        collected.push(trimmed);
        return;
      }
      if (value && typeof value === 'object' && 'folio_digital' in value) {
        const folio = String(
          (value as { folio_digital?: unknown }).folio_digital ?? '',
        ).trim();
        if (folio) {
          collected.push(folio);
        }
      }
    };

    this.collectTraceabilityFolios(body, collected, pushFolio);
    return Array.from(new Set(collected.filter(Boolean)));
  }

  private collectTraceabilityFolios(
    body: unknown,
    collected: string[],
    pushFolio?: (value: unknown) => void,
  ): void {
    const push =
      pushFolio ||
      ((value: unknown) => {
        if (typeof value === 'string' && value.trim()) {
          collected.push(value.trim());
        } else if (value && typeof value === 'object' && 'folio_digital' in value) {
          const folio = String(
            (value as { folio_digital?: unknown }).folio_digital ?? '',
          ).trim();
          if (folio) {
            collected.push(folio);
          }
        }
      });

    if (body == null) {
      return;
    }

    if (typeof body === 'string') {
      push(body);
      return;
    }

    if (Array.isArray(body)) {
      for (const item of body) {
        push(item);
      }
      return;
    }

    if (typeof body === 'object') {
      const obj = body as Record<string, unknown>;
      if ('body' in obj) {
        this.collectTraceabilityFolios(obj.body, collected, push);
      }
      push(obj.folio_digital);
      if (Array.isArray(obj.folios)) {
        for (const item of obj.folios) {
          push(item);
        }
      } else if (typeof obj.folios === 'string') {
        push(obj.folios);
      }
    }
  }
}
