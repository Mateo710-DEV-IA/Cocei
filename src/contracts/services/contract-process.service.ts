import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ContractData,
  ProcessCancelledResult,
  ProcessDocumentResult,
  ProcessResult,
} from '../interfaces/contract-data.interface';
import { GoogleWorkspaceService } from './google-workspace.service';
import { SqlService } from './sql.service';
import { DeepseekMailComposerService } from './deepseek-mail-composer.service';
import * as ExcelJS from 'exceljs';
import JSZip from 'jszip';

@Injectable()
export class ContractProcessService {
  private readonly logger = new Logger(ContractProcessService.name);

  constructor(
    private readonly sqlService: SqlService,
    private readonly googleService: GoogleWorkspaceService,
    private readonly configService: ConfigService,
    private readonly deepseekComposer: DeepseekMailComposerService,
  ) {}

  async processByFolio(
    folioDigital: string,
  ): Promise<ProcessResult | ProcessCancelledResult> {
    try {
      const data = await this.sqlService.getContractByFolio(folioDigital);
      if (Number(data.contrato.is_cancelado || 0) === 1) {
        return {
          folio_digital: folioDigital,
          id_contrato: data.contrato.id_contrato,
          cancelled: true,
          message:
            'El proceso ya fue cancelado para este folio. No se generan OT/OS ni nuevos envios.',
        };
      }

      const processFolderId = this.resolveParentFolderId(data);
      if (!processFolderId) {
        throw new BadRequestException(
          `El contrato ${folioDigital} no tiene iddrive y no existe fallback de carpeta en configuracion.`,
        );
      }

      const sourceDocument =
        await this.googleService.getSingleReadableDocumentFromFolder(processFolderId);
    const serviceFocus = this.deepseekComposer.deriveServiceFocusFromContract({
      sourceText: sourceDocument.extractedText,
      fallbackService: data.contrato.nom_servicio,
    });
      const summaryResult = await this.deepseekComposer.summarizeDocument({
        folio: data.contrato.folio_digital,
      service: serviceFocus,
        observations: data.contrato.detalle_servicio,
        sourceFileName: sourceDocument.fileName,
        sourceText: sourceDocument.extractedText,
      });
    const sourceExcerpt = this.deepseekComposer.buildMailSafeSourceExcerpt(
      sourceDocument.extractedText,
      1800,
    );

      this.logger.log(
        `Resumen inteligente generado desde ${sourceDocument.fileName} (${sourceDocument.fileId}) source=${summaryResult.source}.`,
      );

      const results: Partial<Record<'OT' | 'OS', ProcessDocumentResult>> = {};
      const flowConfigs = this.buildFlowConfigs(data);
      const blockedSignatures = new Set<string>();

      for (const config of flowConfigs) {
        results[config.docType] = await this.generateDocumentFlow({
          data,
          processFolderId,
          intelligentSummary: summaryResult.summary,
        serviceFocus,
          sourceExcerpt,
          blockedSignatures,
          ...config,
        });
      }

      return {
        folio_digital: folioDigital,
        id_contrato: data.contrato.id_contrato,
        driveFolderId: processFolderId,
        ot: results.OT as ProcessDocumentResult,
        os: results.OS as ProcessDocumentResult,
      };
    } catch (error) {
      const message = (error as Error)?.message ?? '';
      if (
        message.includes('Modo estricto activo') ||
        message.includes('no especifica') ||
        message.includes('no hace referencia') ||
        message.includes('no expresa claramente') ||
        message.includes('anclado al contenido del PDF')
      ) {
        throw new BadRequestException(`Regla estricta IA: ${message}`);
      }
      if (
        error instanceof BadRequestException ||
        error instanceof InternalServerErrorException
      ) {
        throw error;
      }
      throw new InternalServerErrorException(message || 'Error interno en processByFolio');
    }
  }

  async cancelByFolio(
    folioDigital: string,
  ): Promise<{
    folio_digital: string;
    id_contrato: number;
    cancelled: true;
    driveFolderId: string;
    bitacora: { fileId: string; name: string; webViewLink: string } | null;
    message: string;
  }> {
    const data = await this.sqlService.getContractByFolio(folioDigital);
    const folderId = this.resolveParentFolderId(data);
    if (!folderId) {
      throw new BadRequestException(
        `El contrato ${folioDigital} no tiene iddrive y no existe carpeta de fallback en configuracion.`,
      );
    }

    await this.sqlService.setContractCancelStatus({
      idContrato: data.contrato.id_contrato,
      isCancelado: true,
    });

    const bitacora = await this.generateBitacoraForCancellation({
      folio: folioDigital,
      idContrato: data.contrato.id_contrato,
      folderId,
      contract: data,
    });

    const hasEtapa16 = await this.sqlService.hasContractDetailByStage({
      idContrato: data.contrato.id_contrato,
      idEtapa: 16,
    });
    if (!hasEtapa16) {
      const cancelDocName = bitacora?.name || `${folioDigital}_Cancelacion`;
      const cancelDocUrl = bitacora?.webViewLink || '';
      await this.sqlService.insertContractDetail({
        idContrato: data.contrato.id_contrato,
        idEtapa: 16,
        nomDocumento: cancelDocName,
        urlDocumento: cancelDocUrl,
      });
    }

    if (bitacora) {
      const refreshedTimeline = await this.sqlService.getContractDetailTimeline(
        data.contrato.id_contrato,
      );
      const refreshedBitacora = await this.buildBitacoraWorkbookBuffer({
        folio: folioDigital,
        contract: data,
        templateFileId: this.configService.getOrThrow<string>('GOOGLE_BITACORA_SHEET_ID'),
        timeline: refreshedTimeline,
      });
      await this.googleService.updateFile({
        fileId: bitacora.fileId,
        fileName: bitacora.name,
        buffer: refreshedBitacora,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    }

    return {
      folio_digital: folioDigital,
      id_contrato: data.contrato.id_contrato,
      cancelled: true,
      driveFolderId: folderId,
      bitacora: bitacora
        ? {
            fileId: bitacora.fileId,
            name: bitacora.name,
            webViewLink: bitacora.webViewLink,
          }
        : null,
      message:
        'Proceso cancelado correctamente. Se actualizo isCancelado=1 y se registraron etapas 15 y 16.',
    };
  }

  async buildTraceabilityZipByFolios(params: {
    folios: string[];
  }): Promise<{ fileName: string; zipBuffer: Buffer; missingFolios: string[] }> {
    const uniqueFolios = Array.from(
      new Set(
        (params.folios || [])
          .map((item) => String(item || '').trim())
          .filter((item) => item.length > 0),
      ),
    );

    if (!uniqueFolios.length) {
      throw new BadRequestException('Debes enviar al menos un folio para descarga.');
    }

    const zip = new JSZip();
    const missingFolios: string[] = [];

    for (const folio of uniqueFolios) {
      try {
        const contract = await this.sqlService.getContractByFolio(folio);
        const folderId = this.resolveParentFolderId(contract);
        if (!folderId) {
          missingFolios.push(folio);
          continue;
        }

        const files = await this.googleService.downloadFolderTree({
          folderId,
          rootPath: folio,
        });
        if (!files.length) {
          missingFolios.push(folio);
          continue;
        }

        for (const item of files) {
          zip.file(item.relativePath, item.buffer);
        }
      } catch {
        missingFolios.push(folio);
      }
    }

    const hasFiles = Object.keys(zip.files).length > 0;
    if (!hasFiles) {
      throw new BadRequestException(
        'No se encontraron carpetas/archivos de trazabilidad para los folios solicitados.',
      );
    }

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return {
      fileName: `trazabilidad_folios_${stamp}.zip`,
      zipBuffer,
      missingFolios,
    };
  }

  private async generateDocumentFlow(params: {
    data: ContractData;
    processFolderId: string;
    intelligentSummary: string;
    serviceFocus: string;
    sourceExcerpt: string;
    blockedSignatures: Set<string>;
    docType: 'OT' | 'OS';
    templateId: string;
    etapa: number;
    mailTo: string;
    replacements: Record<string, string>;
    qrPayload: string;
  }): Promise<ProcessDocumentResult> {
    const docName = `${params.data.contrato.folio_digital}_${params.docType}`;
    const docId = await this.googleService.copyTemplateDocument({
      templateDocumentId: params.templateId,
      name: docName,
      parentFolderId: params.processFolderId,
    });

    await this.googleService.replaceAllText(docId, params.replacements);

    const qrUrl = this.googleService.getQrUrlFromText(params.qrPayload);
    await this.googleService.insertQrAtMarker({
      documentId: docId,
      marker: '{{qr}}',
      imageUrl: qrUrl,
      widthPt: params.docType === 'OT' ? 80 : 100,
      heightPt: params.docType === 'OT' ? 80 : 100,
    });

    const pdfBuffer = await this.googleService.exportDocumentToPdf(docId);
    const pdfName = `${docName}.pdf`;
    const pdfDrive = await this.googleService.uploadPdf({
      folderId: params.processFolderId,
      fileName: pdfName,
      pdfBuffer,
    });

    const composedMail = await this.deepseekComposer.compose({
      docType: params.docType,
      folio: params.data.contrato.folio_digital,
      service: params.data.contrato.nom_servicio || params.serviceFocus,
      observations: params.data.contrato.detalle_servicio,
      summaryContext: params.intelligentSummary,
      sourceExcerpt: params.sourceExcerpt,
      recipientRole: params.docType === 'OT' ? 'integradora' : 'ejecutora',
      blockedSignatures: params.blockedSignatures,
    });

    this.logger.log(
      `[MAIL_COMPOSED] ${params.docType} source=${composedMail.source} profile=${composedMail.profile.perfil} tone=${composedMail.profile.tono_general}`,
    );

    const mail = await this.googleService.sendMailWithPdf({
      to: params.mailTo,
      subject: this.resolveSubject(params, composedMail.subject),
      message:
        composedMail.message ||
        `Documento ${params.docType} generado para el folio ${params.data.contrato.folio_digital}.`,
      pdfFileName: pdfName,
      pdfBuffer,
    });

    const emlName = `${docName}.eml`;
    const emlDrive = await this.googleService.uploadEml({
      folderId: params.processFolderId,
      fileName: emlName,
      emlBuffer: mail.emlBuffer,
    });

    await this.sqlService.insertContractDetail({
      idContrato: params.data.contrato.id_contrato,
      idEtapa: params.etapa,
      nomDocumento: pdfDrive.name,
      urlDocumento: pdfDrive.webViewLink,
    });

    await this.googleService.deleteFile(docId);

    return {
      pdfFileId: pdfDrive.fileId,
      pdfName: pdfDrive.name,
      webViewLink: pdfDrive.webViewLink,
      mailTo: params.mailTo,
      mailMessageId: mail.messageId,
      emlFileId: emlDrive.fileId,
      emlName: emlDrive.name,
      emlWebViewLink: emlDrive.webViewLink,
    };
  }

  private formatDate(value: string): string {
    if (!value) {
      return '';
    }
    const raw = String(value).trim();
    const isoLike = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoLike) {
      return `${isoLike[1]}-${isoLike[2]}-${isoLike[3]}`;
    }

    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      const year = parsed.getFullYear();
      const month = String(parsed.getMonth() + 1).padStart(2, '0');
      const day = String(parsed.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (dmy) {
      const day = dmy[1].padStart(2, '0');
      const month = dmy[2].padStart(2, '0');
      return `${dmy[3]}-${month}-${day}`;
    }

    return raw;
  }

  private resolveParentFolderId(data: ContractData): string {
    return (
      data.contrato.iddrive ||
      this.configService.get<string>('GOOGLE_DRIVE_PARENT_FOLDER_ID', '')
    );
  }

  private buildFlowConfigs(data: ContractData): Array<{
    docType: 'OT' | 'OS';
    templateId: string;
    etapa: number;
    mailTo: string;
    replacements: Record<string, string>;
    qrPayload: string;
  }> {
    const commonReplacements = {
      folio: data.contrato.folio_digital,
      jobNumber: String(data.contrato.id_contrato),
      date: this.formatDate(data.contrato.fecha_ini),
      service: data.contrato.nom_servicio,
      observations: data.contrato.detalle_servicio,
    };

    return [
      {
        docType: 'OT',
        templateId: this.configService.getOrThrow<string>('GOOGLE_OT_TEMPLATE_DOC_ID'),
        etapa: 2,
        mailTo: data.contrato.email_integradora,
        replacements: {
          ...commonReplacements,
          companyNameSol: data.solicitante.razon_social,
          rfcApplicantSol: data.solicitante.rfc,
          homeSol: data.solicitante.direccion,
          companyNameInt: data.integradora.razon_social,
          rfcInt: data.integradora.rfc,
          homeInt: data.integradora.direccion,
        },
        qrPayload: this.buildWorkOrderQrPayload(data),
      },
      {
        docType: 'OS',
        templateId: this.configService.getOrThrow<string>('GOOGLE_OS_TEMPLATE_DOC_ID'),
        etapa: 3,
        mailTo: data.contrato.email_ejecutora,
        replacements: {
          ...commonReplacements,
          companyNameInt: data.integradora.razon_social,
          rfcInt: data.integradora.rfc,
          homeInt: data.integradora.direccion,
          companyNameEjec: data.ejecutora.razon_social,
          rfcEjec: data.ejecutora.rfc || data.contrato.rfc_ejecutora,
          homeEjec: data.ejecutora.direccion,
        },
        qrPayload: this.buildServiceOrderQrPayload(data),
      },
    ];
  }

  private resolveSubject(
    params: { docType: 'OT' | 'OS'; data: ContractData },
    _suggestedSubject: string,
  ): string {
    const folio = (params.data.contrato.folio_digital || '').trim();
    if (params.docType === 'OT') {
      return folio;
    }
    return `${folio}-OS`;
  }

  private buildWorkOrderQrPayload(data: ContractData): string {
    return [
      `Orden de trabajo: ${data.contrato.folio_digital || 'N/A'}`,
      `Fecha de creacion: ${this.formatDate(data.contrato.fecha_ini) || 'N/A'}`,
      `Razon social solicitante: ${data.solicitante.razon_social || 'N/A'}`,
      `RFC solicitante: ${data.solicitante.rfc || 'N/A'}`,
      `Razon social integradora: ${data.integradora.razon_social || 'N/A'}`,
      `RFC integradora: ${data.integradora.rfc || 'N/A'}`,
    ].join('\n');
  }

  private buildServiceOrderQrPayload(data: ContractData): string {
    return [
      `Orden de servicio: ${data.contrato.folio_digital || 'N/A'}`,
      `Fecha de creacion: ${this.formatDate(data.contrato.fecha_ini) || 'N/A'}`,
      `Razon social integradora: ${data.integradora.razon_social || 'N/A'}`,
      `RFC integradora: ${data.integradora.rfc || 'N/A'}`,
      `Razon social ejecutora: ${data.ejecutora.razon_social || 'N/A'}`,
      `RFC ejecutora: ${data.ejecutora.rfc || data.contrato.rfc_ejecutora || 'N/A'}`,
    ].join('\n');
  }

  private async generateBitacoraForCancellation(params: {
    folio: string;
    idContrato: number;
    folderId: string;
    contract: ContractData;
  }): Promise<{ fileId: string; name: string; webViewLink: string } | null> {
    const templateId = this.configService.get<string>('GOOGLE_BITACORA_SHEET_ID', '');
    if (!templateId) {
      this.logger.warn(`[CANCEL_SKIP] folio=${params.folio} sin template de bitacora.`);
      return null;
    }

    const fileName = `${params.folio}_Bitacora.xlsx`;
    const existingEtapa15 = await this.sqlService.hasContractDetailByStage({
      idContrato: params.idContrato,
      idEtapa: 15,
    });

    const timeline = await this.sqlService.getContractDetailTimeline(params.idContrato);
    const buffer = await this.buildBitacoraWorkbookBuffer({
      folio: params.folio,
      contract: params.contract,
      templateFileId: templateId,
      timeline,
    });

    let uploaded: { fileId: string; name: string; webViewLink: string };
    if (!existingEtapa15) {
      uploaded = await this.googleService.uploadFile({
        folderId: params.folderId,
        fileName,
        buffer,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      await this.sqlService.insertContractDetail({
        idContrato: params.idContrato,
        idEtapa: 15,
        nomDocumento: uploaded.name,
        urlDocumento: uploaded.webViewLink,
      });
    } else {
      const existingRow = timeline
        .slice()
        .reverse()
        .find((item) => item.idEtapa === 15);
      const existingName = existingRow?.nomDocumento || fileName;
      const existingUrl = existingRow?.urlDocumento || '';
      const existingFileId = this.extractDriveFileIdFromUrl(existingUrl);
      if (!existingFileId) {
        uploaded = await this.googleService.uploadFile({
          folderId: params.folderId,
          fileName: existingName,
          buffer,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
      } else {
        uploaded = await this.googleService.updateFile({
          fileId: existingFileId,
          fileName: existingName,
          buffer,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
      }
    }

    const timelineWithBitacora = await this.sqlService.getContractDetailTimeline(params.idContrato);
    const refreshed = await this.buildBitacoraWorkbookBuffer({
      folio: params.folio,
      contract: params.contract,
      templateFileId: templateId,
      timeline: timelineWithBitacora,
    });
    await this.googleService.updateFile({
      fileId: uploaded.fileId,
      fileName: uploaded.name,
      buffer: refreshed,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    return uploaded;
  }

  private async buildBitacoraWorkbookBuffer(params: {
    folio: string;
    contract: ContractData;
    templateFileId: string;
    timeline: Array<{
      idEtapa: number;
      nomEtapa: string;
      fechaDet: Date | string | null;
      nomDocumento: string;
      urlDocumento: string;
    }>;
  }): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const templateBuffer = await this.googleService.downloadFileBuffer(params.templateFileId);
    await workbook.xlsx.load(templateBuffer as unknown as any);
    const sheet = workbook.getWorksheet('Bitácora') ?? workbook.worksheets[0];
    if (!sheet) {
      throw new InternalServerErrorException(
        'No se encontro hoja para generar bitacora de cancelacion.',
      );
    }

    sheet.getCell('B3').value = params.folio;
    sheet.getCell('B5').value = params.contract.contrato.nom_servicio || '';
    sheet.getCell('B6').value = params.contract.solicitante.razon_social || '';
    sheet.getCell('B7').value = params.contract.integradora.razon_social || '';
    sheet.getCell('B8').value = params.contract.ejecutora.razon_social || '';
    sheet.getCell('A10').value = `DETALLE DE EVENTOS  (${params.timeline.length} registros)`;

    const startRow = 12;
    for (let i = 0; i < params.timeline.length; i += 1) {
      const event = params.timeline[i];
      const row = startRow + i;
      const date = this.normalizeDate(event.fechaDet);
      sheet.getCell(`A${row}`).value = this.formatDateValue(date);
      sheet.getCell(`B${row}`).value = this.formatTimeValue(date);
      sheet.getCell(`C${row}`).value = event.nomEtapa;
      const documentCell = sheet.getCell(`D${row}`);
      documentCell.value = this.buildEventDocumentCell(event);
      documentCell.alignment = {
        ...(documentCell.alignment || {}),
        wrapText: true,
        vertical: 'top',
      };
    }

    const out = (await workbook.xlsx.writeBuffer()) as Buffer | ArrayBuffer;
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  }

  private buildEventDocumentCell(event: {
    idEtapa: number;
    nomDocumento: string;
    urlDocumento: string;
  }): string {
    const names = String(event.nomDocumento || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const urls = String(event.urlDocumento || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    if (event.idEtapa === 15) {
      const name = names[0] || 'Bitacora';
      const url = urls[0] || '';
      return url ? `${name}\n${url}` : name;
    }
    return names.join('\n');
  }

  private normalizeDate(value: Date | string | null): Date | null {
    if (!value) {
      return null;
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private formatDateValue(value: Date | null): string {
    if (!value) {
      return '';
    }
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  private formatTimeValue(value: Date | null): string {
    if (!value) {
      return '';
    }
    const hh = String(value.getHours()).padStart(2, '0');
    const mm = String(value.getMinutes()).padStart(2, '0');
    const ss = String(value.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  private extractDriveFileIdFromUrl(url: string): string {
    const source = String(url || '');
    if (!source) {
      return '';
    }
    const slashMatch = source.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (slashMatch?.[1]) {
      return slashMatch[1];
    }
    const idMatch = source.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    return idMatch?.[1] || '';
  }
}
