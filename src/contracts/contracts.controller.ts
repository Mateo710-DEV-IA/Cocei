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

@Controller('contracts')
export class ContractsController {
  constructor(private readonly actions: ContractsActionsService) {}

  @Post('upload-pdf')
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
    return this.actions.uploadPdf(body, files);
  }

  @Post('process')
  processContract(@Req() req: Request) {
    return this.actions.processContract(req);
  }

  @Post('cancel')
  cancelContract(@Req() req: Request) {
    return this.actions.cancelContract(req);
  }

  @Post('traceability/download')
  downloadTraceability(@Req() req: Request, @Res() res: Response) {
    return this.actions.downloadTraceability(req, res);
  }
}
