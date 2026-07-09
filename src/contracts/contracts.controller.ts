import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { UploadPdfDto } from './dto/upload-pdf.dto';
import { ProcessContractDto } from './dto/process-contract.dto';
import { CancelContractDto } from './dto/cancel-contract.dto';
import { DownloadTraceabilityDto } from './dto/download-traceability.dto';
import { GoogleWorkspaceService } from './services/google-workspace.service';
import { ContractProcessService } from './services/contract-process.service';

@Controller('contracts')
export class ContractsController {
  constructor(
    private readonly googleService: GoogleWorkspaceService,
    private readonly processService: ContractProcessService,
    private readonly configService: ConfigService,
  ) {}

  @Post('upload-pdf')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 15 * 1024 * 1024 },
      fileFilter: (_req, file, callback) => {
        if (file.mimetype !== 'application/pdf') {
          callback(new BadRequestException('El archivo debe ser PDF'), false);
          return;
        }
        callback(null, true);
      },
    }),
  )
  async uploadPdf(
    @Body() body: UploadPdfDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Debes enviar el archivo PDF en campo "file"');
    }

    const parentFolderId =
      this.configService.get<string>('GOOGLE_DRIVE_PARENT_FOLDER_ID') || undefined;
    const folderName = body.folio_digital;
    const folderId = await this.googleService.createFolder(folderName, parentFolderId);

    const upload = await this.googleService.uploadPdf({
      folderId,
      fileName: file.originalname || `${body.folio_digital}.pdf`,
      pdfBuffer: file.buffer,
    });

    return {
      message: 'PDF cargado correctamente',
      folio_digital: body.folio_digital,
      folderId,
      file: upload,
    };
  }

  @Post('process')
  async processContract(@Body() body: ProcessContractDto) {
    return this.processService.processByFolio(body.folio_digital);
  }

  @Post('cancel')
  async cancelContract(@Body() body: CancelContractDto) {
    return this.processService.cancelByFolio(body.folio_digital);
  }

  @Post('traceability/download')
  async downloadTraceability(
    @Body() body: DownloadTraceabilityDto,
    @Res() res: Response,
  ) {
    const folios = Array.from(
      new Set(
        [body.folio_digital, ...(body.folios || [])]
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
