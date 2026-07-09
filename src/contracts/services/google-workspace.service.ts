import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { docs_v1, drive_v3, gmail_v1, google } from 'googleapis';
import { PDFParse } from 'pdf-parse';
import { Readable } from 'stream';

@Injectable()
export class GoogleWorkspaceService {
  private readonly drive: drive_v3.Drive;
  private readonly docs: docs_v1.Docs;
  private readonly gmail: gmail_v1.Gmail;
  private readonly gmailUserId: string;

  constructor(private readonly configService: ConfigService) {
    const driveAuthMode = this.configService.get<string>(
      'GOOGLE_DRIVE_AUTH_MODE',
      'service_account',
    );
    const gmailAuthMode = this.configService.get<string>(
      'GOOGLE_GMAIL_AUTH_MODE',
      'service_account',
    );

    const needsServiceAccountKey =
      driveAuthMode === 'service_account' || gmailAuthMode === 'service_account';
    const privateKey = needsServiceAccountKey
      ? this.configService
          .getOrThrow<string>('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY')
          .replace(/\\n/g, '\n')
      : '';

    const driveAndDocsSubject =
      this.configService.get<string>('GOOGLE_DRIVE_IMPERSONATED_USER') ||
      this.configService.get<string>('GOOGLE_IMPERSONATED_USER');
    const gmailSubject =
      this.configService.get<string>('GOOGLE_GMAIL_IMPERSONATED_USER') ||
      this.configService.get<string>('GOOGLE_IMPERSONATED_USER');

    const driveDocsAuth = this.buildDriveDocsAuth(privateKey, driveAndDocsSubject);
    const gmailAuth = this.buildGmailAuth(privateKey, gmailSubject);
    this.gmailUserId = this.configService.get<string>('GOOGLE_GMAIL_USER_ID', 'me');

    this.drive = google.drive({ version: 'v3', auth: driveDocsAuth });
    this.docs = google.docs({ version: 'v1', auth: driveDocsAuth });
    this.gmail = google.gmail({ version: 'v1', auth: gmailAuth });
  }

  async createFolder(name: string, parentFolderId?: string): Promise<string> {
    const res = await this.drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentFolderId ? [parentFolderId] : undefined,
      },
      supportsAllDrives: true,
      fields: 'id',
    });

    if (!res.data.id) {
      throw new InternalServerErrorException('No se pudo crear carpeta en Drive');
    }

    return res.data.id;
  }

  async uploadPdf(params: {
    folderId: string;
    fileName: string;
    pdfBuffer: Buffer;
  }): Promise<{ fileId: string; webViewLink: string; name: string }> {
    return this.uploadBuffer({
      folderId: params.folderId,
      fileName: params.fileName,
      buffer: params.pdfBuffer,
      mimeType: 'application/pdf',
      errorMessage: 'No se pudo subir PDF a Drive',
    });
  }

  async uploadEml(params: {
    folderId: string;
    fileName: string;
    emlBuffer: Buffer;
  }): Promise<{ fileId: string; webViewLink: string; name: string }> {
    return this.uploadBuffer({
      folderId: params.folderId,
      fileName: params.fileName,
      buffer: params.emlBuffer,
      mimeType: 'message/rfc822',
      errorMessage: 'No se pudo subir EML a Drive',
    });
  }

  async uploadFile(params: {
    folderId: string;
    fileName: string;
    buffer: Buffer;
    mimeType: string;
  }): Promise<{ fileId: string; webViewLink: string; name: string }> {
    return this.uploadBuffer({
      folderId: params.folderId,
      fileName: params.fileName,
      buffer: params.buffer,
      mimeType: params.mimeType || 'application/octet-stream',
      errorMessage: 'No se pudo subir archivo a Drive',
    });
  }

  async copyTemplateDocument(params: {
    templateDocumentId: string;
    name: string;
    parentFolderId: string;
  }): Promise<string> {
    const copy = await this.drive.files.copy({
      fileId: params.templateDocumentId,
      requestBody: {
        name: params.name,
        parents: [params.parentFolderId],
      },
      supportsAllDrives: true,
      fields: 'id',
    });

    if (!copy.data.id) {
      throw new InternalServerErrorException('No se pudo crear copia del template');
    }

    return copy.data.id;
  }

  async replaceAllText(
    documentId: string,
    replacements: Record<string, string>,
  ): Promise<void> {
    const requests: docs_v1.Schema$Request[] = Object.entries(replacements).map(
      ([placeholder, value]) => ({
        replaceAllText: {
          containsText: {
            text: `{{${placeholder}}}`,
            matchCase: true,
          },
          replaceText: value ?? '',
        },
      }),
    );

    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests },
    });
  }

  async insertQrAtMarker(params: {
    documentId: string;
    marker: string;
    imageUrl: string;
    widthPt?: number;
    heightPt?: number;
  }): Promise<void> {
    const doc = await this.docs.documents.get({ documentId: params.documentId });
    const markerRange = this.findMarkerRangeInDocument(doc.data, params.marker);

    if (!markerRange) {
      throw new BadRequestException(
        `No se encontro el marcador "${params.marker}" en el documento. El QR solo puede insertarse en esa variable.`,
      );
    }

    await this.docs.documents.batchUpdate({
      documentId: params.documentId,
      requestBody: {
        requests: [
          {
            deleteContentRange: {
              range: {
                startIndex: markerRange.startIndex,
                endIndex: markerRange.endIndex,
              },
            },
          },
          {
            insertInlineImage: {
              uri: params.imageUrl,
              location: {
                index: markerRange.startIndex,
              },
              objectSize: {
                width: {
                  magnitude: params.widthPt ?? 90,
                  unit: 'PT',
                },
                height: {
                  magnitude: params.heightPt ?? 90,
                  unit: 'PT',
                },
              },
            },
          },
        ],
      },
    });
  }

  async exportDocumentToPdf(documentId: string): Promise<Buffer> {
    const response = (await this.drive.files.export(
      {
        fileId: documentId,
        mimeType: 'application/pdf',
      },
      { responseType: 'arraybuffer' },
    )) as { data: ArrayBuffer };

    return Buffer.from(response.data);
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.drive.files.delete({ fileId, supportsAllDrives: true });
  }

  async downloadFileBuffer(fileId: string): Promise<Buffer> {
    const response = (await this.drive.files.get(
      {
        fileId,
        alt: 'media',
        supportsAllDrives: true,
      },
      { responseType: 'arraybuffer' },
    )) as unknown as { data: ArrayBuffer };

    return Buffer.from(response.data);
  }

  async updateFile(params: {
    fileId: string;
    fileName: string;
    buffer: Buffer;
    mimeType: string;
  }): Promise<{ fileId: string; webViewLink: string; name: string }> {
    const res = await this.drive.files.update({
      fileId: params.fileId,
      requestBody: {
        name: params.fileName,
      },
      media: {
        mimeType: params.mimeType || 'application/octet-stream',
        body: Readable.from(params.buffer),
      },
      supportsAllDrives: true,
      fields: 'id,webViewLink,name',
    });

    if (!res.data.id) {
      throw new InternalServerErrorException('No se pudo actualizar archivo en Drive');
    }

    return {
      fileId: res.data.id,
      webViewLink: res.data.webViewLink ?? '',
      name: res.data.name ?? params.fileName,
    };
  }

  async downloadFolderTree(params: {
    folderId: string;
    rootPath: string;
  }): Promise<Array<{ relativePath: string; buffer: Buffer }>> {
    const collected: Array<{ relativePath: string; buffer: Buffer }> = [];
    await this.collectFolderFilesRecursive({
      folderId: params.folderId,
      currentPath: this.sanitizeZipSegment(params.rootPath || params.folderId),
      out: collected,
    });
    return collected;
  }

  async sendMailWithPdf(params: {
    to: string;
    subject: string;
    message: string;
    pdfFileName: string;
    pdfBuffer: Buffer;
  }): Promise<{ messageId: string; emlBuffer: Buffer }> {
    const mime = this.buildMimeMessage({
      to: params.to,
      subject: params.subject,
      message: params.message,
      pdfFileName: params.pdfFileName,
      pdfBuffer: params.pdfBuffer,
    });
    const raw = this.encodeBase64Url(Buffer.from(mime, 'utf8'));

    const sent = await this.gmail.users.messages.send({
      userId: this.gmailUserId,
      requestBody: { raw },
    });

    return {
      messageId: sent.data.id ?? '',
      emlBuffer: Buffer.from(mime, 'utf8'),
    };
  }

  async getSingleReadableDocumentFromFolder(folderId: string): Promise<{
    fileId: string;
    fileName: string;
    mimeType: string;
    extractedText: string;
  }> {
    const files = await this.listEligibleSourceFiles(folderId);
    if (!files.length) {
      throw new NotFoundException(
        `No se encontro documento fuente en la carpeta de Drive ${folderId}`,
      );
    }

    if (files.length > 1) {
      const fileNames = files.map((file) => file.name || file.id).join(', ');
      throw new BadRequestException(
        `La carpeta ${folderId} tiene mas de un documento candidato (${fileNames}). Debe existir solo uno.`,
      );
    }

    const file = files[0];
    const fileId = file.id ?? '';
    const fileName = file.name ?? 'documento_sin_nombre';
    const mimeType = file.mimeType ?? '';
    if (!fileId || !mimeType) {
      throw new InternalServerErrorException(
        'El documento fuente no tiene identificador o tipo MIME valido.',
      );
    }

    const extractedText = await this.extractTextFromDriveFile(fileId, mimeType);
    if (!extractedText.trim()) {
      throw new BadRequestException(
        `No se pudo extraer texto util del documento ${fileName}.`,
      );
    }

    return {
      fileId,
      fileName,
      mimeType,
      extractedText: extractedText.trim(),
    };
  }

  getQrUrlFromText(content: string): string {
    const encoded = encodeURIComponent(content);
    return `https://quickchart.io/qr?text=${encoded}&size=250&format=png`;
  }

  private async listEligibleSourceFiles(folderId: string) {
    const response = await this.drive.files.list({
      q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: 'files(id,name,mimeType)',
      pageSize: 100,
    });

    return (response.data.files ?? []).filter((file) => {
      const name = (file.name ?? '').toLowerCase();
      const mime = file.mimeType ?? '';

      if (name.endsWith('.eml')) {
        return false;
      }
      if (name.includes('_ot') || name.includes('_os')) {
        return false;
      }
      if (
        [
          'application/pdf',
          'text/plain',
          'application/vnd.google-apps.document',
        ].includes(mime)
      ) {
        return true;
      }

      return false;
    });
  }

  private async extractTextFromDriveFile(fileId: string, mimeType: string): Promise<string> {
    if (mimeType === 'application/vnd.google-apps.document') {
      const response = (await this.drive.files.export(
        {
          fileId,
          mimeType: 'text/plain',
        },
        { responseType: 'arraybuffer' },
      )) as { data: ArrayBuffer };
      return Buffer.from(response.data).toString('utf8');
    }

    const response = (await this.drive.files.get(
      {
        fileId,
        alt: 'media',
        supportsAllDrives: true,
      },
      { responseType: 'arraybuffer' },
    )) as unknown as { data: ArrayBuffer };
    const buffer = Buffer.from(response.data);

    if (mimeType === 'application/pdf') {
      const parser = new PDFParse({ data: buffer });
      const parsed = await parser.getText();
      await parser.destroy();
      return parsed.text ?? '';
    }

    if (mimeType === 'text/plain') {
      return buffer.toString('utf8');
    }

    return '';
  }

  private findMarkerRange(
    content: docs_v1.Schema$StructuralElement[],
    marker: string,
  ): { startIndex: number; endIndex: number } | null {
    const normalizedTarget = this.normalizeMarker(marker);
    for (const element of content) {
      if (element.paragraph?.elements) {
        for (const paragraphElement of element.paragraph.elements) {
          const text = paragraphElement.textRun?.content ?? '';
          const normalizedText = this.normalizeMarker(text);
          if (
            text.includes(marker) ||
            normalizedText.includes(normalizedTarget) ||
            normalizedText.includes('image_qr') ||
            normalizedText.includes('imageqr')
          ) {
            return {
              startIndex: paragraphElement.startIndex ?? 1,
              endIndex: (paragraphElement.endIndex ?? 2) - 1,
            };
          }
        }
      }

      if (element.table?.tableRows) {
        for (const row of element.table.tableRows) {
          for (const cell of row.tableCells ?? []) {
            const nested = this.findMarkerRange(cell.content ?? [], marker);
            if (nested) {
              return nested;
            }
          }
        }
      }
    }

    return null;
  }

  private findMarkerRangeInDocument(
    document: docs_v1.Schema$Document,
    marker: string,
  ): { startIndex: number; endIndex: number } | null {
    const bodyMatch = this.findMarkerRange(document.body?.content ?? [], marker);
    if (bodyMatch) {
      return bodyMatch;
    }

    const headers = document.headers ?? {};
    for (const header of Object.values(headers)) {
      const headerMatch = this.findMarkerRange(header.content ?? [], marker);
      if (headerMatch) {
        return headerMatch;
      }
    }

    const footers = document.footers ?? {};
    for (const footer of Object.values(footers)) {
      const footerMatch = this.findMarkerRange(footer.content ?? [], marker);
      if (footerMatch) {
        return footerMatch;
      }
    }

    return null;
  }

  private normalizeMarker(value: string): string {
    return value.replace(/\s+/g, '').replace(/[{}]/g, '').toLowerCase();
  }

  private async uploadBuffer(params: {
    folderId: string;
    fileName: string;
    buffer: Buffer;
    mimeType: string;
    errorMessage: string;
  }): Promise<{ fileId: string; webViewLink: string; name: string }> {
    const res = await this.drive.files.create({
      requestBody: {
        name: params.fileName,
        parents: [params.folderId],
      },
      media: {
        mimeType: params.mimeType,
        body: Readable.from(params.buffer),
      },
      supportsAllDrives: true,
      fields: 'id,webViewLink,name',
    });

    if (!res.data.id) {
      throw new InternalServerErrorException(params.errorMessage);
    }

    return {
      fileId: res.data.id,
      webViewLink: res.data.webViewLink ?? '',
      name: res.data.name ?? params.fileName,
    };
  }

  private async collectFolderFilesRecursive(params: {
    folderId: string;
    currentPath: string;
    out: Array<{ relativePath: string; buffer: Buffer }>;
  }): Promise<void> {
    const response = await this.drive.files.list({
      q: `'${params.folderId}' in parents and trashed = false`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: 'files(id,name,mimeType)',
      pageSize: 1000,
    });

    const files = response.data.files ?? [];
    for (const file of files) {
      const fileId = file.id ?? '';
      const fileName = file.name ?? 'archivo_sin_nombre';
      const mimeType = file.mimeType ?? 'application/octet-stream';
      if (!fileId) {
        continue;
      }

      if (mimeType === 'application/vnd.google-apps.folder') {
        await this.collectFolderFilesRecursive({
          folderId: fileId,
          currentPath: `${params.currentPath}/${this.sanitizeZipSegment(fileName)}`,
          out: params.out,
        });
        continue;
      }

      const downloaded = await this.downloadDriveFileForZip({
        fileId,
        fileName,
        mimeType,
      });
      if (!downloaded) {
        continue;
      }

      params.out.push({
        relativePath: `${params.currentPath}/${this.sanitizeZipSegment(downloaded.fileName)}`,
        buffer: downloaded.buffer,
      });
    }
  }

  private async downloadDriveFileForZip(params: {
    fileId: string;
    fileName: string;
    mimeType: string;
  }): Promise<{ fileName: string; buffer: Buffer } | null> {
    const nativeMimeMap: Record<string, { exportMime: string; extension: string }> = {
      'application/vnd.google-apps.document': {
        exportMime:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extension: '.docx',
      },
      'application/vnd.google-apps.spreadsheet': {
        exportMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extension: '.xlsx',
      },
      'application/vnd.google-apps.presentation': {
        exportMime:
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        extension: '.pptx',
      },
      'application/vnd.google-apps.drawing': {
        exportMime: 'image/png',
        extension: '.png',
      },
    };

    const native = nativeMimeMap[params.mimeType];
    if (native) {
      const exportResponse = (await this.drive.files.export(
        {
          fileId: params.fileId,
          mimeType: native.exportMime,
        },
        { responseType: 'arraybuffer' },
      )) as { data: ArrayBuffer };
      const exportedName = this.ensureExtension(params.fileName, native.extension);
      return {
        fileName: exportedName,
        buffer: Buffer.from(exportResponse.data),
      };
    }

    if (params.mimeType.startsWith('application/vnd.google-apps.')) {
      return null;
    }

    const response = (await this.drive.files.get(
      {
        fileId: params.fileId,
        alt: 'media',
        supportsAllDrives: true,
      },
      { responseType: 'arraybuffer' },
    )) as unknown as { data: ArrayBuffer };
    return {
      fileName: params.fileName,
      buffer: Buffer.from(response.data),
    };
  }

  private ensureExtension(fileName: string, extension: string): string {
    if (!extension) {
      return fileName;
    }
    if (fileName.toLowerCase().endsWith(extension.toLowerCase())) {
      return fileName;
    }
    return `${fileName}${extension}`;
  }

  private sanitizeZipSegment(value: string): string {
    return String(value || '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private buildMimeMessage(params: {
    to: string;
    subject: string;
    message: string;
    pdfFileName: string;
    pdfBuffer: Buffer;
  }): string {
    const mixedBoundary = `mixed_${Date.now()}`;
    const altBoundary = `alt_${Date.now()}`;
    const plainText = String(params.message || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const htmlText = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#202124;"><p style="margin:0;white-space:normal;">${this.escapeHtml(
      plainText,
    )}</p></div>`;
    const plainBase64 = this.foldBase64(
      Buffer.from(plainText, 'utf8').toString('base64'),
    );
    const htmlBase64 = this.foldBase64(
      Buffer.from(htmlText, 'utf8').toString('base64'),
    );
    const pdfBase64 = this.foldBase64(params.pdfBuffer.toString('base64'));
    const encodedSubject = this.encodeMimeHeader(params.subject || '');

    return [
      `To: ${params.to}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
      '',
      `--${mixedBoundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
      `--${altBoundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      plainBase64,
      '',
      `--${altBoundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      htmlBase64,
      '',
      `--${altBoundary}--`,
      '',
      `--${mixedBoundary}`,
      'Content-Type: application/pdf; name="' + params.pdfFileName + '"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="' + params.pdfFileName + '"',
      '',
      pdfBase64,
      '',
      `--${mixedBoundary}--`,
    ].join('\r\n');
  }

  private escapeHtml(value: string): string {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private foldBase64(value: string): string {
    const compact = String(value || '').replace(/\s+/g, '');
    const lines: string[] = [];
    for (let i = 0; i < compact.length; i += 76) {
      lines.push(compact.slice(i, i + 76));
    }
    return lines.join('\r\n');
  }

  private encodeBase64Url(buffer: Buffer): string {
    return buffer
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  private encodeMimeHeader(value: string): string {
    const raw = String(value ?? '').trim();
    if (!raw) {
      return '';
    }
    const base64 = Buffer.from(raw, 'utf8').toString('base64');
    return `=?UTF-8?B?${base64}?=`;
  }

  private buildGmailAuth(privateKey: string, gmailSubject?: string) {
    const gmailAuthMode = this.configService.get<string>(
      'GOOGLE_GMAIL_AUTH_MODE',
      'service_account',
    );

    if (gmailAuthMode === 'oauth') {
      const clientId = this.configService.getOrThrow<string>(
        'GOOGLE_GMAIL_OAUTH_CLIENT_ID',
      );
      const clientSecret = this.configService.getOrThrow<string>(
        'GOOGLE_GMAIL_OAUTH_CLIENT_SECRET',
      );
      const redirectUri = this.configService.get<string>(
        'GOOGLE_GMAIL_OAUTH_REDIRECT_URI',
      );
      const refreshToken = this.configService.getOrThrow<string>(
        'GOOGLE_GMAIL_OAUTH_REFRESH_TOKEN',
      );

      const oauth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
        redirectUri,
      );
      oauth2Client.setCredentials({ refresh_token: refreshToken });
      return oauth2Client;
    }

    return new google.auth.JWT({
      email: this.configService.getOrThrow<string>('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
      key: privateKey,
      subject: gmailSubject,
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
    });
  }

  private buildDriveDocsAuth(privateKey: string, driveSubject?: string) {
    const driveAuthMode = this.configService.get<string>(
      'GOOGLE_DRIVE_AUTH_MODE',
      'service_account',
    );

    if (driveAuthMode === 'oauth') {
      const clientId = this.configService.getOrThrow<string>(
        'GOOGLE_DRIVE_OAUTH_CLIENT_ID',
      );
      const clientSecret = this.configService.getOrThrow<string>(
        'GOOGLE_DRIVE_OAUTH_CLIENT_SECRET',
      );
      const redirectUri = this.configService.get<string>(
        'GOOGLE_DRIVE_OAUTH_REDIRECT_URI',
      );
      const refreshToken = this.configService.getOrThrow<string>(
        'GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN',
      );

      const oauth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
        redirectUri,
      );
      oauth2Client.setCredentials({ refresh_token: refreshToken });
      return oauth2Client;
    }

    return new google.auth.JWT({
      email: this.configService.getOrThrow<string>('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
      key: privateKey,
      subject: driveSubject,
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/spreadsheets',
      ],
    });
  }
}
