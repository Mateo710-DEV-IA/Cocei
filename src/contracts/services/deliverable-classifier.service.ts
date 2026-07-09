import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PDFParse } from 'pdf-parse';

export type ContentTipo = 'factura' | 'pago' | 'entregable' | 'no_aplica';

export interface ContentClassificationResult {
  tipo: ContentTipo;
  es_entregable: boolean;
  confianza: number;
  razon: string;
  source: 'ai' | 'heuristic';
  extractedSummary: string;
}

/** @deprecated Prefer ContentClassificationResult; kept for callers that only need entregable yes/no */
export interface DeliverableClassificationResult {
  es_entregable: boolean;
  confianza: number;
  razon: string;
  source: 'ai' | 'heuristic';
}

interface AttachmentInput {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

type AnthropicContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    }
  | {
      type: 'document';
      source: { type: 'base64'; media_type: 'application/pdf'; data: string };
    };

@Injectable()
export class DeliverableClassifierService {
  private readonly logger = new Logger(DeliverableClassifierService.name);
  private readonly cursorApiUrl = 'https://api.anthropic.com/v1/messages';
  private readonly maxAttachments = 8;
  private readonly maxBytesPerFile = 4.5 * 1024 * 1024;

  constructor(private readonly configService: ConfigService) {}

  async classifyContent(params: {
    folio: string;
    subject: string;
    bodyText: string;
    attachments: AttachmentInput[];
  }): Promise<ContentClassificationResult> {
    const apiKey = this.getAiApiKey();
    const textContext = await this.buildAttachmentTextContext(params.attachments);
    const multimodalParts = await this.buildMultimodalParts(params);

    if (apiKey) {
      try {
        const content = await this.callCursorAnthropic({
          apiKey,
          model: this.getModel(),
          systemPrompt:
            'Eres un clasificador documental para contratos de servicios en Mexico. Primero lees TODO el contenido del correo y adjuntos (texto, PDF, imagenes via OCR/vision). Luego decides. Responde SOLO JSON valido.',
          userContent: multimodalParts,
          maxTokens: 500,
          temperature: 0.1,
        });
        const parsed = this.parseClassificationJson(content, textContext);
        if (parsed) {
          return { ...parsed, source: 'ai' };
        }
      } catch (error) {
        const message = (error as Error).message;
        this.logger.warn(
          `Clasificacion IA multimodal fallo para folio=${params.folio}: ${message}`,
        );

        // Fallback: reintento solo con texto/extractos (por si el endpoint no acepta document/image).
        try {
          const textOnlyParts: AnthropicContentPart[] = [
            {
              type: 'text',
              text: [
                'Analiza el correo y el extracto de adjuntos. Clasifica en factura|pago|entregable|no_aplica.',
                `Folio: ${params.folio}`,
                `Asunto: ${params.subject}`,
                `Cuerpo: ${params.bodyText.slice(0, 1500)}`,
                `Adjuntos:\n${textContext}`,
                'Responde SOLO JSON: {"tipo":"factura"|"pago"|"entregable"|"no_aplica","confianza":0.0-1.0,"razon":"...","extracted_summary":"..."}',
              ].join('\n'),
            },
          ];
          const content = await this.callCursorAnthropic({
            apiKey,
            model: this.getModel(),
            systemPrompt:
              'Eres un clasificador documental para contratos de servicios en Mexico. Responde SOLO JSON valido.',
            userContent: textOnlyParts,
            maxTokens: 500,
            temperature: 0.1,
          });
          const parsed = this.parseClassificationJson(content, textContext);
          if (parsed) {
            return { ...parsed, source: 'ai' };
          }
        } catch (fallbackError) {
          this.logger.warn(
            `Clasificacion IA texto fallo para folio=${params.folio}: ${(fallbackError as Error).message}`,
          );
          if (this.isStrictModeEnabled()) {
            throw fallbackError;
          }
        }
      }
    } else if (this.isStrictModeEnabled()) {
      throw new Error(
        'Modo estricto activo: CURSOR_API_KEY es obligatoria para clasificar contenido.',
      );
    }

    const heuristic = this.classifyWithHeuristics(params.attachments, textContext);
    this.logger.log(
      `[CONTENT_HEURISTIC] folio=${params.folio} tipo=${heuristic.tipo} confianza=${heuristic.confianza}`,
    );
    return { ...heuristic, source: 'heuristic' };
  }

  async confirmEntregables(params: {
    folio: string;
    subject: string;
    bodyText: string;
    attachments: AttachmentInput[];
  }): Promise<DeliverableClassificationResult> {
    const result = await this.classifyContent(params);
    return {
      es_entregable: result.es_entregable,
      confianza: result.confianza,
      razon: result.razon,
      source: result.source,
    };
  }

  private async buildMultimodalParts(params: {
    folio: string;
    subject: string;
    bodyText: string;
    attachments: AttachmentInput[];
  }): Promise<AnthropicContentPart[]> {
    const parts: AnthropicContentPart[] = [
      {
        type: 'text',
        text: [
          'Analiza el correo completo y TODOS los adjuntos (usa OCR/vision en imagenes y PDFs).',
          'Luego clasifica el contenido principal en UNA categoria:',
          '- factura: CFDI, factura fiscal PDF+XML, comprobante fiscal',
          '- pago: SPEI, transferencia, recibo bancario, comprobante de pago',
          '- entregable: evidencias de trabajo, fotos de instalacion/obra, reportes, actas, PDFs de avance',
          '- no_aplica: gracias, dudas, texto sin docs utiles, o contenido que no encaja',
          '',
          `Folio: ${params.folio}`,
          `Asunto: ${params.subject}`,
          `Cuerpo: ${params.bodyText.slice(0, 1500)}`,
          `Cantidad de adjuntos: ${params.attachments.length}`,
          '',
          'Responde SOLO JSON:',
          '{"tipo":"factura"|"pago"|"entregable"|"no_aplica","confianza":0.0-1.0,"razon":"explicacion breve","extracted_summary":"resumen de lo leido en adjuntos"}',
          'Si hay adjuntos, no uses null. Decide con base en el contenido leido, no solo el nombre del archivo.',
        ].join('\n'),
      },
    ];

    for (const attachment of params.attachments.slice(0, this.maxAttachments)) {
      const mime = (attachment.mimeType || '').toLowerCase();
      const name = attachment.filename || 'sin_nombre';
      const buffer = attachment.buffer;

      if (!buffer?.length) {
        parts.push({ type: 'text', text: `Adjunto ${name}: vacio` });
        continue;
      }

      if (buffer.length > this.maxBytesPerFile) {
        const excerpt = await this.extractPdfTextSafe(buffer, mime, name);
        parts.push({
          type: 'text',
          text: `Adjunto ${name} (${mime}, ${buffer.length} bytes, omitido binario por tamano). Extracto: ${excerpt.slice(0, 1200)}`,
        });
        continue;
      }

      if (mime.startsWith('image/')) {
        const mediaType = this.normalizeImageMediaType(mime);
        parts.push({
          type: 'text',
          text: `Imagen adjunta: ${name}`,
        });
        parts.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: buffer.toString('base64'),
          },
        });
        continue;
      }

      if (mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf')) {
        parts.push({
          type: 'text',
          text: `PDF adjunto: ${name} (leer completo con OCR/vision si aplica)`,
        });
        parts.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: buffer.toString('base64'),
          },
        });
        continue;
      }

      if (mime.includes('xml') || name.toLowerCase().endsWith('.xml')) {
        parts.push({
          type: 'text',
          text: `XML adjunto ${name}:\n${buffer.toString('utf8').slice(0, 2000)}`,
        });
        continue;
      }

      if (mime.startsWith('text/') || name.toLowerCase().endsWith('.txt')) {
        parts.push({
          type: 'text',
          text: `Texto adjunto ${name}:\n${buffer.toString('utf8').slice(0, 2000)}`,
        });
        continue;
      }

      parts.push({
        type: 'text',
        text: `Adjunto ${name} (${mime || 'desconocido'}): binario no tipado para vision; clasificar con el resto del contexto.`,
      });
    }

    return parts;
  }

  private async buildAttachmentTextContext(attachments: AttachmentInput[]): Promise<string> {
    const lines: string[] = [];
    for (const attachment of attachments.slice(0, this.maxAttachments)) {
      const mime = (attachment.mimeType || '').toLowerCase();
      const name = attachment.filename || 'sin_nombre';
      let excerpt = '';

      if (mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf')) {
        excerpt = await this.extractPdfText(attachment.buffer);
      } else if (mime.startsWith('image/')) {
        excerpt = '[imagen adjunta - requiere vision/OCR]';
      } else if (mime.includes('xml') || name.toLowerCase().endsWith('.xml')) {
        excerpt = attachment.buffer.toString('utf8').slice(0, 600);
      } else {
        excerpt = `[archivo ${mime || 'desconocido'}]`;
      }

      lines.push(`- ${name} (${mime}): ${excerpt.slice(0, 800)}`);
    }
    return lines.join('\n') || '- sin detalle de adjuntos';
  }

  private async extractPdfTextSafe(
    buffer: Buffer,
    mime: string,
    name: string,
  ): Promise<string> {
    if (mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf')) {
      return this.extractPdfText(buffer);
    }
    return '[sin extracto]';
  }

  private async extractPdfText(buffer: Buffer): Promise<string> {
    try {
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      await parser.destroy();
      return String(result.text || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    } catch {
      return '[pdf sin texto extraible]';
    }
  }

  private normalizeImageMediaType(mime: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
    if (mime === 'image/png' || mime === 'image/gif' || mime === 'image/webp') {
      return mime;
    }
    return 'image/jpeg';
  }

  private classifyWithHeuristics(
    attachments: AttachmentInput[],
    attachmentContext: string,
  ): Omit<ContentClassificationResult, 'source'> {
    const lowerNames = attachments.map((a) => (a.filename || '').toLowerCase());
    const mimes = attachments.map((a) => (a.mimeType || '').toLowerCase());
    const hasXml =
      mimes.some((m) => m.includes('xml')) || lowerNames.some((n) => n.endsWith('.xml'));
    const hasPdf =
      mimes.some((m) => m === 'application/pdf') || lowerNames.some((n) => n.endsWith('.pdf'));
    const hasImage = mimes.some((m) => m.startsWith('image/'));
    const hasZip =
      mimes.some((m) => m.includes('zip')) || lowerNames.some((n) => n.endsWith('.zip'));
    const contextLower = attachmentContext.toLowerCase();

    const paymentSignals = [
      'spei',
      'transferencia',
      'comprobante de pago',
      'referencia bancaria',
      'clabe',
    ];
    const invoiceSignals = [
      'cfdi:comprobante',
      'uuid',
      'factura',
      'tipo de comprobante',
      'rfc emisor',
    ];
    const deliverableSignals = [
      'entregable',
      'evidencia',
      'acta',
      'instalacion',
      'fotograf',
      'reporte',
      'avance',
    ];

    if (hasXml && hasPdf) {
      return {
        tipo: 'factura',
        es_entregable: false,
        confianza: 0.88,
        razon: 'Adjuntos PDF+XML compatibles con documento fiscal.',
        extractedSummary: attachmentContext.slice(0, 500),
      };
    }

    if (invoiceSignals.some((signal) => contextLower.includes(signal))) {
      return {
        tipo: 'factura',
        es_entregable: false,
        confianza: 0.8,
        razon: 'Contenido compatible con factura/CFDI.',
        extractedSummary: attachmentContext.slice(0, 500),
      };
    }

    if (paymentSignals.some((signal) => contextLower.includes(signal))) {
      return {
        tipo: 'pago',
        es_entregable: false,
        confianza: 0.82,
        razon: 'Contenido compatible con comprobante de pago.',
        extractedSummary: attachmentContext.slice(0, 500),
      };
    }

    if (hasImage || hasZip || deliverableSignals.some((s) => contextLower.includes(s))) {
      return {
        tipo: 'entregable',
        es_entregable: true,
        confianza: 0.78,
        razon: 'Adjuntos compatibles con evidencias o entregables de servicio.',
        extractedSummary: attachmentContext.slice(0, 500),
      };
    }

    if (hasPdf) {
      return {
        tipo: 'entregable',
        es_entregable: true,
        confianza: 0.65,
        razon: 'PDF sin senales fiscales/pago; se trata como entregable por defecto.',
        extractedSummary: attachmentContext.slice(0, 500),
      };
    }

    if (!attachments.length) {
      return {
        tipo: 'no_aplica',
        es_entregable: false,
        confianza: 0.9,
        razon: 'Sin adjuntos para clasificar.',
        extractedSummary: '',
      };
    }

    return {
      tipo: 'no_aplica',
      es_entregable: false,
      confianza: 0.55,
      razon: 'Adjuntos presentes sin senales claras de factura, pago o entregable.',
      extractedSummary: attachmentContext.slice(0, 500),
    };
  }

  private parseClassificationJson(
    content: string,
    fallbackSummary: string,
  ): Omit<ContentClassificationResult, 'source'> | null {
    try {
      const clean = content.trim().replace(/^```json/i, '').replace(/```$/, '').trim();
      const firstBrace = clean.indexOf('{');
      const lastBrace = clean.lastIndexOf('}');
      const jsonCandidate =
        firstBrace >= 0 && lastBrace > firstBrace
          ? clean.slice(firstBrace, lastBrace + 1)
          : clean;
      const parsed = JSON.parse(jsonCandidate) as {
        tipo?: string;
        es_entregable?: boolean;
        confianza?: number;
        razon?: string;
        extracted_summary?: string;
      };

      const tipo = this.normalizeTipo(parsed.tipo, parsed.es_entregable);
      return {
        tipo,
        es_entregable: tipo === 'entregable',
        confianza: Math.min(1, Math.max(0, Number(parsed.confianza ?? 0.7))),
        razon: String(parsed.razon || 'Clasificacion IA').trim(),
        extractedSummary: String(parsed.extracted_summary || fallbackSummary)
          .trim()
          .slice(0, 800),
      };
    } catch {
      return null;
    }
  }

  private normalizeTipo(raw: string | undefined, esEntregable?: boolean): ContentTipo {
    const value = String(raw || '')
      .toLowerCase()
      .trim();
    if (value === 'factura' || value === 'pago' || value === 'entregable' || value === 'no_aplica') {
      return value;
    }
    if (esEntregable === true) {
      return 'entregable';
    }
    if (esEntregable === false) {
      return 'no_aplica';
    }
    return 'no_aplica';
  }

  private getAiApiKey(): string {
    return (
      this.configService.get<string>('CURSOR_API_KEY', '').trim() ||
      this.configService.get<string>('API_CURSOR', '').trim()
    );
  }

  private getModel(): string {
    return this.configService.get<string>('CURSOR_MODEL', 'claude-sonnet-4-6');
  }

  private isStrictModeEnabled(): boolean {
    return this.configService.get<string>('AI_STRICT_MODE', 'true') === 'true';
  }

  private getAiTimeoutMs(): number {
    return Number(this.configService.get<string>('AI_TIMEOUT_MS', '45000'));
  }

  private async callCursorAnthropic(params: {
    apiKey: string;
    model: string;
    systemPrompt: string;
    userContent: AnthropicContentPart[];
    maxTokens: number;
    temperature: number;
  }): Promise<string> {
    const controller = new AbortController();
    const timeoutMs = this.getAiTimeoutMs();
    const timer = setTimeout(() => controller.abort(), Math.max(5000, timeoutMs));
    const apiUrl =
      this.configService.get<string>('CURSOR_API_URL', '').trim() || this.cursorApiUrl;

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': params.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: params.maxTokens,
        temperature: params.temperature,
        system: params.systemPrompt,
        messages: [{ role: 'user', content: params.userContent }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Cursor/Anthropic HTTP ${res.status}: ${errorText}`);
    }

    const json = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text =
      json.content
        ?.filter((item) => item.type === 'text')
        .map((item) => item.text ?? '')
        .join('\n')
        .trim() ?? '';

    if (!text) {
      throw new Error('Respuesta IA vacia');
    }
    return text;
  }
}
