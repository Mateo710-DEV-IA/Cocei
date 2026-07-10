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
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request, Response } from 'express';
import { isPdfUpload } from './cocei-compat';
import { ContractsActionsService } from './services/contracts-actions.service';

@Controller('contracts')
export class ContractsController {
  private readonly logger = new Logger(ContractsController.name);

  constructor(private readonly actions: ContractsActionsService) {}

  @Post('upload-pdf')
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
  uploadPdf(
    @Body() body: Record<string, unknown>,
    @UploadedFiles()
    files: { file?: Express.Multer.File[]; pdf_file?: Express.Multer.File[] },
  ) {
    this.logger.log(`[HTTP_HIT] POST /contracts/upload-pdf`);
    return this.actions.uploadPdf(body, files, '/contracts/upload-pdf');
  }

  @Post('process')
  @HttpCode(200)
  processContract(@Req() req: Request) {
    this.logger.log(`[HTTP_HIT] POST /contracts/process`);
    return this.actions.processContract(req, '/contracts/process');
  }

  @Post('cancel')
  @HttpCode(200)
  cancelContract(@Req() req: Request) {
    this.logger.log(`[HTTP_HIT] POST /contracts/cancel`);
    return this.actions.cancelContract(req, '/contracts/cancel');
  }

  @Post('traceability/download')
  @HttpCode(200)
  downloadTraceability(@Req() req: Request, @Res() res: Response) {
    this.logger.log(`[HTTP_HIT] POST /contracts/traceability/download`);
    return this.actions.downloadTraceability(
      req,
      res,
      '/contracts/traceability/download',
    );
  }
}
