import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import {
  FileFieldsInterceptor,
  NoFilesInterceptor,
} from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request, Response } from 'express';
import { isPdfUpload } from './cocei-compat';
import { ContractsActionsService } from './services/contracts-actions.service';

/**
 * Rutas legacy que Cocei PHP ya llama en producción (webhooks n8n).
 * Permite desplegar automation-api sin tocar una línea del PHP.
 */
@Controller('webhook')
export class LegacyWebhookController {
  private readonly logger = new Logger(LegacyWebhookController.name);

  constructor(private readonly actions: ContractsActionsService) {}

  @Post('48a8c68c-2953-4728-a57c-8e0ba0ccec0f')
  @HttpCode(200)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'file', maxCount: 1 },
        { name: 'pdf_file', maxCount: 1 },
      ],
      {
        storage: memoryStorage(),
        limits: { fileSize: 15 * 1024 * 1024 },
        fileFilter: (_req, file, callback) => {
          if (!isPdfUpload(file)) {
            callback(
              new BadRequestException(
                'El archivo debe ser PDF (campo "file" o "pdf_file")',
              ),
              false,
            );
            return;
          }
          callback(null, true);
        },
      },
    ),
  )
  uploadPdfLegacy(
    @Body() body: Record<string, unknown>,
    @UploadedFiles()
    files: { file?: Express.Multer.File[]; pdf_file?: Express.Multer.File[] },
  ) {
    this.logger.log(
      `[HTTP_HIT] POST /webhook/48a8c68c-2953-4728-a57c-8e0ba0ccec0f (upload PHP)`,
    );
    return this.actions.uploadPdf(
      body,
      files,
      '/webhook/48a8c68c-2953-4728-a57c-8e0ba0ccec0f',
    );
  }

  @Post('start_process_automation')
  @HttpCode(200)
  @UseInterceptors(NoFilesInterceptor())
  processLegacy(@Req() req: Request) {
    this.logger.log(`[HTTP_HIT] POST /webhook/start_process_automation`);
    return this.actions.processContract(req, '/webhook/start_process_automation');
  }

  @Post('cancel_process_automation')
  @HttpCode(200)
  @UseInterceptors(NoFilesInterceptor())
  cancelLegacy(@Req() req: Request) {
    this.logger.log(`[HTTP_HIT] POST /webhook/cancel_process_automation`);
    return this.actions.cancelContract(req, '/webhook/cancel_process_automation');
  }

  @Post('342591cc-8617-440d-b649-b2562c780490')
  @HttpCode(200)
  @UseInterceptors(NoFilesInterceptor())
  downloadLegacy(@Req() req: Request, @Res() res: Response) {
    this.logger.log(
      `[HTTP_HIT] POST /webhook/342591cc-8617-440d-b649-b2562c780490 (traceability)`,
    );
    return this.actions.downloadTraceability(
      req,
      res,
      '/webhook/342591cc-8617-440d-b649-b2562c780490',
    );
  }
}
