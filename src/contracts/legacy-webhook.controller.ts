import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
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
  constructor(private readonly actions: ContractsActionsService) {}

  @Post('48a8c68c-2953-4728-a57c-8e0ba0ccec0f')
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
    return this.actions.uploadPdf(body, files);
  }

  @Post('start_process_automation')
  processLegacy(@Req() req: Request) {
    return this.actions.processContract(req);
  }

  @Post('cancel_process_automation')
  cancelLegacy(@Req() req: Request) {
    return this.actions.cancelContract(req);
  }

  @Post('342591cc-8617-440d-b649-b2562c780490')
  downloadLegacy(@Req() req: Request, @Res() res: Response) {
    return this.actions.downloadTraceability(req, res);
  }
}
