import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';

type MailDocType = 'OT' | 'OS';

interface MailProfile {
  perfil: string;
  estilo_escritura: string;
  apertura: string;
  estructura: string;
  tono_general: string;
  expresiones_clave: string;
  extension: string;
  largo_esperado: string;
  naturalidad: string;
  tips_naturalidad: string;
}

interface ComposeResult {
  subject: string;
  message: string;
  profile: MailProfile;
  source: 'ai' | 'fallback';
}

interface SummaryResult {
  summary: string;
  source: 'ai' | 'fallback';
}

@Injectable()
export class DeepseekMailComposerService {
  private readonly logger = new Logger(DeepseekMailComposerService.name);
  private readonly cursorApiUrl = 'https://api.anthropic.com/v1/messages';

  constructor(private readonly configService: ConfigService) {}

  async compose(params: {
    docType: MailDocType;
    folio: string;
    service: string;
    observations: string;
    summaryContext: string;
    sourceExcerpt: string;
    recipientRole: 'integradora' | 'ejecutora';
    blockedSignatures?: Set<string>;
  }): Promise<ComposeResult> {
    const profile = this.createRandomProfile();
    const fallback = this.buildFallback(params, profile);
    const strictMode = this.isStrictModeEnabled();
    const maxAttempts = this.getComposeMaxAttempts();

    const apiKey = this.getAiApiKey();
    if (!apiKey) {
      if (strictMode) {
        throw new Error(
          'Modo estricto activo: CURSOR_API_KEY es obligatoria para redactar correos.',
        );
      }
      this.logger.warn(
        'CURSOR_API_KEY no configurado. Se usa mensaje fallback controlado.',
      );
      return { ...fallback, profile, source: 'fallback' };
    }

    const model = this.getModelByDocType(params.docType);
    const blocked = params.blockedSignatures ?? new Set<string>();
    let lastErrorMessage = '';
    let correctionHints: string[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const prompt = this.buildPrompt(
        params,
        profile,
        randomUUID(),
        correctionHints,
      );

      try {
        const content = await this.callCursorAnthropic({
          apiKey,
          model,
          temperature: 0.55,
          systemPrompt:
            'Redactas correos operativos cortos en espanol mexicano. El cuerpo va corrido, sin saltos de linea. Responde SOLO JSON con llaves "subject" y "message".',
          userPrompt: prompt,
          maxTokens: 350,
        });
        const parsed = this.parseModelJson(content);

        if (!parsed.subject || !parsed.message) {
          throw new Error('Respuesta IA sin subject/message validos');
        }
        const normalizedMessage = this.validateGeneratedMessage({
          rawMessage: parsed.message,
          structure: profile.estructura,
          service: params.service,
          docType: params.docType,
        });

        const signature = this.createSignature(parsed.subject, normalizedMessage);
        if (blocked.has(signature)) {
          lastErrorMessage = `Texto repetido detectado en intento ${attempt}.`;
          correctionHints = this.buildCorrectionHints(lastErrorMessage, correctionHints);
          this.logger.warn(
            `Modelo IA genero texto repetido para ${params.docType} (intento ${attempt}). Reintentando...`,
          );
          continue;
        }

        blocked.add(signature);
        return {
          subject: parsed.subject,
          message: normalizedMessage,
          profile,
          source: 'ai',
        };
      } catch (error) {
        lastErrorMessage = (error as Error).message || 'Error IA sin detalle.';
        correctionHints = this.buildCorrectionHints(lastErrorMessage, correctionHints);
        this.logger.warn(
          `Validacion IA fallo para ${params.docType} (intento ${attempt}/${maxAttempts}): ${lastErrorMessage}`,
        );
        if (attempt === maxAttempts) {
          if (strictMode) {
            throw new Error(
              `Modo estricto activo: fallo IA en redaccion ${params.docType} despues de ${maxAttempts} intentos. ${lastErrorMessage}`,
            );
          }
          this.logger.warn(
            `Fallo IA para ${params.docType} tras ${maxAttempts} intentos. Se usa fallback. Motivo: ${lastErrorMessage}`,
          );
          return { ...fallback, profile, source: 'fallback' };
        }
      }
    }

    if (strictMode) {
      throw new Error('Modo estricto activo: no se pudo generar correo con IA.');
    }
    return { ...fallback, profile, source: 'fallback' };
  }

  async summarizeDocument(params: {
    folio: string;
    service: string;
    observations: string;
    sourceFileName: string;
    sourceText: string;
  }): Promise<SummaryResult> {
    const strictMode = this.isStrictModeEnabled();
    const sourceText = params.sourceText.trim();
    if (!sourceText) {
      if (strictMode) {
        throw new Error(
          'Modo estricto activo: el contrato no tiene texto legible para resumir.',
        );
      }
      return { summary: this.buildSummaryFallback(params), source: 'fallback' };
    }

    const apiKey = this.getAiApiKey();
    if (!apiKey) {
      if (strictMode) {
        throw new Error(
          'Modo estricto activo: CURSOR_API_KEY es obligatoria para resumir contrato.',
        );
      }
      this.logger.warn(
        'CURSOR_API_KEY no configurado para resumen. Se usa resumen fallback.',
      );
      return { summary: this.buildSummaryFallback(params), source: 'fallback' };
    }

    const previewText = sourceText.slice(0, 12000);
    const prompt = [
      'Analiza el contrato y extrae SOLO informacion util del servicio a solicitar.',
      `Folio: ${params.folio}`,
      `Archivo: ${params.sourceFileName}`,
      `Servicio: ${params.service || '(sin servicio)'}`,
      `Observaciones SQL: ${params.observations || '(sin observaciones)'}`,
      '',
      'Documento fuente:',
      previewText,
      '',
      'Responde SOLO JSON valido con llaves:',
      '{"servicio_detectado":"...", "objetivo_servicio":"...", "alcance_servicio":["..."], "contexto_operativo":["..."], "requisitos_servicio":["..."], "restricciones":["..."]}',
    ].join('\n');

    try {
      const content = await this.callCursorAnthropic({
        apiKey,
        model: this.getSummaryModel(),
        temperature: 0.4,
        systemPrompt:
          'Eres analista documental. Entregas resumen ejecutivo preciso y util para comunicaciones operativas.',
        userPrompt: prompt,
        maxTokens: 1400,
      });
      const clean = content.trim().replace(/^```json/i, '').replace(/```$/, '').trim();
      const parsed = JSON.parse(clean) as {
        resumen_general?: string;
        servicio_detectado?: string;
        objetivo_servicio?: string;
        alcance_servicio?: string[];
        contexto_operativo?: string[];
        requisitos_servicio?: string[];
        restricciones?: string[];
        puntos_clave?: string[];
        requisitos?: string[];
        riesgos?: string[];
      };

      const servicioDetectado = String(
        parsed.servicio_detectado ?? params.service ?? '',
      ).trim();
      const objetivoServicio = String(parsed.objetivo_servicio ?? '').trim();
      const alcance = (parsed.alcance_servicio ?? parsed.puntos_clave ?? []).map(
        (item) => `- ${item}`,
      );
      const contexto = (parsed.contexto_operativo ?? []).map((item) => `- ${item}`);
      const requisitos = (
        parsed.requisitos_servicio ?? parsed.requisitos ?? []
      ).map((item) => `- ${item}`);
      const restricciones = (parsed.restricciones ?? parsed.riesgos ?? []).map(
        (item) => `- ${item}`,
      );
      const resumenGeneral = String(parsed.resumen_general ?? '').trim();
      const resumen =
        resumenGeneral ||
        `Servicio detectado: ${servicioDetectado || 'No especificado en documento.'}`;

      if (!resumen.trim()) {
        throw new Error('Resumen IA vacio');
      }

      const summary = [
        `Servicio detectado: ${servicioDetectado || 'No especificado en documento.'}`,
        `Objetivo del servicio: ${
          objetivoServicio || 'No especificado en documento.'
        }`,
        `Resumen general: ${resumen}`,
        alcance.length ? '\nAlcance del servicio:\n' + alcance.join('\n') : '',
        contexto.length ? '\nContexto operativo:\n' + contexto.join('\n') : '',
        requisitos.length ? '\nRequisitos:\n' + requisitos.join('\n') : '',
        restricciones.length
          ? '\nRestricciones o notas:\n' + restricciones.join('\n')
          : '',
      ]
        .join('\n')
        .trim();
      if (!this.referencesRequestedService(summary, params.service)) {
        throw new Error(
          'Resumen IA no refleja de forma clara el servicio del contrato.',
        );
      }
      return { summary, source: 'ai' };
    } catch (error) {
      if (strictMode) {
        throw new Error(
          `Modo estricto activo: fallo IA en resumen documental. ${(error as Error).message}`,
        );
      }
      this.logger.warn(
        `Fallo IA para resumen de documento. Se usa fallback. Motivo: ${(error as Error).message}`,
      );
      return { summary: this.buildSummaryFallback(params), source: 'fallback' };
    }
  }

  deriveServiceFocusFromContract(params: {
    sourceText: string;
    fallbackService: string;
  }): string {
    const raw = String(params.sourceText || '');
    const compact = raw.replace(/\s+/g, ' ').trim();
    if (!compact) {
      return String(params.fallbackService || '').trim();
    }

    const objectMatch = compact.match(
      /objeto del contrato(.+?)(iii\.|iv\.|valor y forma de pago|plazo de ejecucion|--\s*\d+\s*of\s*\d+\s*--)/i,
    );
    const section = (objectMatch?.[1] || compact).trim();
    const sentenceMatch = section.match(
      /(servicios? de[^.]{20,350}|desarrollo[^.]{20,350}|implementaci[oó]n[^.]{20,350}|integraci[oó]n[^.]{20,350})/i,
    );

    const candidate = this.sanitizeServiceText(
      sentenceMatch?.[1] || section.slice(0, 350),
    );
    if (candidate.length >= 20) {
      return candidate;
    }
    return String(params.fallbackService || '').trim();
  }

  buildMailSafeSourceExcerpt(sourceText: string, maxChars: number): string {
    const lines = String(sourceText || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const filtered = lines.filter((line) => {
      const normalized = this.normalizeForComparison(line);
      const forbidden = [
        'valor',
        'forma de pago',
        'anticipo',
        'monto',
        'precio',
        'vigencia',
        'clausula',
        'penalizacion',
        'incumplimiento',
      ];
      return !forbidden.some((token) => normalized.includes(token));
    });

    return filtered.join(' ').replace(/\s+/g, ' ').trim().slice(0, maxChars);
  }

  private getModelByDocType(docType: MailDocType): string {
    const byType =
      docType === 'OT'
        ? this.configService.get<string>('CURSOR_MODEL_OT')
        : this.configService.get<string>('CURSOR_MODEL_OS');
    return (
      byType ||
      this.configService.get<string>('CURSOR_MODEL', 'claude-sonnet-4-6')
    );
  }

  private getSummaryModel(): string {
    return this.configService.get<string>('CURSOR_MODEL', 'claude-sonnet-4-6');
  }

  private getAiApiKey(): string {
    return (
      this.configService.get<string>('CURSOR_API_KEY', '').trim() ||
      this.configService.get<string>('API_CURSOR', '').trim() ||
      this.configService.get<string>('DEEPSEEK_API_KEY', '').trim()
    );
  }

  private getAiTimeoutMs(): number {
    return Number(
      this.configService.get<string>(
        'AI_TIMEOUT_MS',
        this.configService.get<string>('DEEPSEEK_TIMEOUT_MS', '15000'),
      ),
    );
  }

  private async callCursorAnthropic(params: {
    apiKey: string;
    model: string;
    temperature: number;
    systemPrompt: string;
    userPrompt: string;
    maxTokens: number;
  }): Promise<string> {
    const controller = new AbortController();
    const timeoutMs = this.getAiTimeoutMs();
    const timer = setTimeout(() => controller.abort(), Math.max(3000, timeoutMs));
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
        messages: [{ role: 'user', content: params.userPrompt }],
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

  private parseModelJson(content: string): { subject: string; message: string } {
    try {
      const clean = content.trim().replace(/^```json/i, '').replace(/```$/, '').trim();
      const firstBrace = clean.indexOf('{');
      const lastBrace = clean.lastIndexOf('}');
      const jsonCandidate =
        firstBrace >= 0 && lastBrace > firstBrace
          ? clean.slice(firstBrace, lastBrace + 1)
          : clean;
      const parsed = JSON.parse(jsonCandidate) as { subject?: string; message?: string };
      return {
        subject: String(parsed.subject ?? '').trim(),
        message: String(parsed.message ?? '').trim(),
      };
    } catch {
      return { subject: '', message: '' };
    }
  }

  private buildPrompt(
    params: {
      docType: MailDocType;
      folio: string;
      service: string;
      observations: string;
      summaryContext: string;
      sourceExcerpt: string;
      recipientRole: 'integradora' | 'ejecutora';
    },
    profile: MailProfile,
    variationSeed: string,
    correctionHints: string[] = [],
  ): string {
    const correctionSection = correctionHints.length
      ? ['REGLAS QUE FALLARON EN INTENTOS PREVIOS (corrigelas obligatoriamente):']
          .concat(correctionHints.map((hint, idx) => `${idx + 1}) ${hint}`))
          .join('\n')
      : 'REGLAS QUE FALLARON EN INTENTOS PREVIOS: ninguna.';

    const docLabel =
      params.docType === 'OT' ? 'orden de trabajo (OT)' : 'orden de servicio (OS)';
    const roleHint =
      params.recipientRole === 'integradora'
        ? 'Destinatario: integradora.'
        : 'Destinatario: ejecutora.';

    return [
      'Redacta un correo CORTO y al punto (2 a 4 oraciones como maximo).',
      `Documento adjunto: ${docLabel}`,
      roleHint,
      `Servicio (usar exactamente este nombre de base de datos): ${params.service || 'servicio solicitado'}`,
      `Semilla de variacion: ${variationSeed}`,
      `Tono sugerido: ${profile.tono_general}. Apertura sugerida: "${profile.apertura}".`,
      '',
      'DEBE incluir, con redaccion natural (no plantilla fija):',
      `1) Que se hace llegar la ${docLabel}.`,
      '2) Que corresponde a la solicitud del servicio indicado arriba.',
      '3) Que se espera su ejecucion.',
      '',
      'REGLAS:',
      '- Espanol mexicano, claro y profesional.',
      '- Variar la redaccion; no copies una frase fija.',
      '- NO inventes montos, fechas, clausulas ni datos extra.',
      '- NO incluyas el folio ni codigos internos en el cuerpo.',
      '- message = UN SOLO texto corrido, sin saltos de linea.',
      '- subject corto y neutro, sin folio.',
      '- Responde SOLO JSON: {"subject":"...","message":"..."}',
      '',
      correctionSection,
    ].join('\n');
  }

  private validateGeneratedMessage(params: {
    rawMessage: string;
    structure: string;
    service: string;
    docType: MailDocType;
  }): string {
    const normalizedMessage = this.normalizeGeneratedMessage(
      params.rawMessage,
      params.structure,
    );
    if (!this.hasValidParagraphShape(normalizedMessage)) {
      throw new Error('La redaccion no tiene forma natural de parrafos.');
    }
    if (normalizedMessage.length > 700) {
      throw new Error('El mensaje es demasiado largo; debe ser corto y al punto.');
    }
    const cleanedMessage = this.stripSuspiciousDetails(normalizedMessage);
    if (this.containsSuspiciousDetails(cleanedMessage)) {
      throw new Error('Incluye informacion sospechosa no permitida.');
    }
    if (!this.referencesRequestedService(cleanedMessage, params.service)) {
      throw new Error('No hace referencia suficientemente clara al servicio.');
    }
    if (!this.referencesDocumentType(cleanedMessage, params.docType)) {
      throw new Error('No menciona la orden de trabajo/servicio enviada.');
    }
    if (!this.hasExecutionExpectation(cleanedMessage)) {
      throw new Error('No indica que se espera la ejecucion.');
    }
    return cleanedMessage;
  }

  private buildFallback(
    params: {
      docType: MailDocType;
      folio: string;
      service: string;
      observations: string;
      summaryContext: string;
      sourceExcerpt: string;
      recipientRole: 'integradora' | 'ejecutora';
    },
    profile: MailProfile,
  ): { subject: string; message: string } {
    const subject =
      params.docType === 'OT' ? 'Orden de trabajo' : 'Orden de servicio';
    const docLabel =
      params.docType === 'OT' ? 'orden de trabajo' : 'orden de servicio';
    const service = params.service || 'servicio solicitado';
    const message = [
      `${profile.apertura}.`,
      `Le hacemos llegar la ${docLabel} con la solicitud del servicio ${service}.`,
      'Quedamos atentos a su ejecucion.',
    ]
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { subject, message };
  }

  private isGroundedToSource(
    message: string,
    summaryContext: string,
    sourceExcerpt: string,
  ): boolean {
    const normalizedMessage = this.normalizeForComparison(message);
    const source = this.normalizeForComparison(`${summaryContext} ${sourceExcerpt}`);
    const tokens = Array.from(
      new Set(
        source
          .split(' ')
          .map((token) => token.trim())
          .filter((token) => token.length >= 5),
      ),
    ).slice(0, 80);

    if (!tokens.length) {
      return normalizedMessage.length > 20;
    }

    let hits = 0;
    for (const token of tokens) {
      if (normalizedMessage.includes(token)) {
        hits += 1;
      }
      if (hits >= 2) {
        return true;
      }
    }
    return false;
  }

  private normalizeForComparison(value: string): string {
    return value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private buildSummaryFallback(params: {
    folio: string;
    service: string;
    observations: string;
    sourceFileName: string;
    sourceText: string;
  }): string {
    const compactText = params.sourceText.replace(/\s+/g, ' ').trim();
    const excerpt = compactText.slice(0, 900);
    return [
      `Resumen general: Documento ${params.sourceFileName} del folio ${params.folio}.`,
      `Servicio: ${params.service || 'N/A'}.`,
      `Observaciones SQL: ${params.observations || 'Sin observaciones'}.`,
      '',
      'Puntos clave:',
      `- Contenido principal detectado: ${excerpt || 'Sin texto legible en documento.'}`,
    ].join('\n');
  }

  private createSignature(subject: string, message: string): string {
    return `${subject.trim().toLowerCase()}|${message
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')}`;
  }

  private isStrictModeEnabled(): boolean {
    return (
      this.configService.get<string>('AI_STRICT_MODE', 'true').toLowerCase() !==
      'false'
    );
  }

  private getComposeMaxAttempts(): number {
    const configured = Number(
      this.configService.get<string>('AI_COMPOSE_MAX_ATTEMPTS', '12'),
    );
    if (!Number.isFinite(configured)) {
      return 12;
    }
    return Math.max(3, Math.min(30, Math.trunc(configured)));
  }

  private buildCorrectionHints(currentError: string, previous: string[]): string[] {
    const hint = String(currentError || '').trim();
    if (!hint) {
      return previous;
    }
    const merged = [...previous, hint];
    return Array.from(new Set(merged)).slice(-6);
  }

  private referencesRequestedService(message: string, service: string): boolean {
    const normalizedMessage = this.normalizeForComparison(message);
    const normalizedService = this.normalizeForComparison(service || '');
    if (!normalizedService) {
      return normalizedMessage.length > 30;
    }
    const serviceTokens = normalizedService
      .split(' ')
      .filter((token) => token.length >= 4);
    if (!serviceTokens.length) {
      return normalizedMessage.includes(normalizedService);
    }
    return serviceTokens.some((token) => normalizedMessage.includes(token));
  }

  private hasRequestIntent(message: string): boolean {
    const normalized = this.normalizeForComparison(message);
    const intents = [
      'solic',
      'requer',
      'necesit',
      'apoy',
      'cotiz',
      'gestionar',
      'atencion',
      'servicio',
    ];
    return intents.some((intent) => normalized.includes(intent));
  }

  private referencesDocumentType(message: string, docType: MailDocType): boolean {
    const normalized = this.normalizeForComparison(message);
    if (docType === 'OT') {
      return (
        normalized.includes('orden de trabajo') ||
        /\bot\b/.test(normalized) ||
        normalized.includes(' orden trabajo')
      );
    }
    return (
      normalized.includes('orden de servicio') ||
      /\bos\b/.test(normalized) ||
      normalized.includes(' orden servicio')
    );
  }

  private hasExecutionExpectation(message: string): boolean {
    const normalized = this.normalizeForComparison(message);
    const intents = [
      'ejecucion',
      'ejecutar',
      'ejecuten',
      'realizar',
      'atencion',
      'seguimiento',
      'procedan',
      'continuen',
    ];
    return intents.some((intent) => normalized.includes(intent));
  }

  private sanitizeServiceText(value: string): string {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .replace(
        /(valor total|forma de pago|anticipo|vigencia|clausula|penalizaci[oó]n|incumplimiento)[^.]*\.?/gi,
        '',
      )
      .trim();
  }

  private hasValidParagraphShape(message: string): boolean {
    const text = String(message || '').trim();
    if (text.length < 20) {
      return false;
    }
    // Debe ir de corrido: sin saltos de linea en el cuerpo final.
    if (/[\r\n]/.test(text)) {
      return false;
    }
    return true;
  }

  private normalizeGeneratedMessage(message: string, _structure: string): string {
    // Siempre un solo bloque corrido: elimina cualquier salto (IA o wrap artificial).
    return String(message || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private stripSuspiciousDetails(message: string): string {
    const sentences = String(message || '')
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 0);
    if (!sentences.length) {
      return String(message || '').trim();
    }

    const kept = sentences.filter(
      (sentence) => !this.containsSuspiciousDetails(sentence),
    );
    const rebuilt = (kept.length ? kept : sentences).join(' ').replace(/\s+/g, ' ').trim();
    return rebuilt;
  }

  private containsSuspiciousDetails(message: string): boolean {
    const normalized = this.normalizeForComparison(message);
    const forbiddenTokens = [
      'fecha de creacion',
      'fecha del contrato',
      'precio',
      'monto',
      'costo total',
      'vigencia',
      'clausula',
      'penalizacion',
      'incumplimiento',
    ];
    return forbiddenTokens.some((token) =>
      normalized.includes(this.normalizeForComparison(token)),
    );
  }

  private containsForbiddenOperationalReferences(
    message: string,
    folio: string,
  ): boolean {
    const normalized = this.normalizeForComparison(message);
    const normalizedFolio = this.normalizeForComparison(folio || '');
    if (normalizedFolio && normalized.includes(normalizedFolio)) {
      return true;
    }

    const forbiddenPatterns = [
      /\bfolio\b/i,
      /\bot\b/i,
      /\bos\b/i,
      /numero de contrato/i,
      /\bcst-\d{4}-\d+\b/i,
      /\b[a-z]{2,}-[a-z]{2,}-[a-z]{2,}-[a-z0-9]{5,}-\d{5}\b/i,
    ];
    return forbiddenPatterns.some((pattern) => pattern.test(message));
  }

  private createRandomProfile(): MailProfile {
    const rand1 = Math.random();
    const rand2 = Math.random();
    const rand3 = Math.random();
    const rand4 = Math.random();
    const rand5 = Math.random();
    const rand6 = Math.random();

    const perfil = this.getProfile(rand1);
    const apertura = this.getOpening(rand2);
    const estructura = this.getStructure(rand3);
    const tono = this.getTone(rand4);
    const extension = this.getLength(rand5);
    const naturalidad = this.getNaturalidad(rand6);

    return {
      perfil: perfil.perfil,
      estilo_escritura: perfil.estilo,
      apertura,
      estructura,
      tono_general: tono.tono,
      expresiones_clave: tono.expresion,
      extension: extension.extension,
      largo_esperado: extension.palabras,
      naturalidad: naturalidad.nivel,
      tips_naturalidad: naturalidad.tips,
    };
  }

  private getProfile(r: number): { perfil: string; estilo: string } {
    if (r < 0.05) return { perfil: 'Dueno de negocio chico', estilo: 'directo, sin rodeos' };
    if (r < 0.1)
      return {
        perfil: 'Encargado administrativo',
        estilo: 'medio formal pero natural',
      };
    if (r < 0.15) return { perfil: 'Emprendedor joven', estilo: 'relajado pero serio' };
    if (r < 0.2) return { perfil: 'Gerente de area', estilo: 'profesional, claro' };
    if (r < 0.25) return { perfil: 'Asistente ejecutiva', estilo: 'cordial, precisa' };
    if (r < 0.3)
      return {
        perfil: 'Coordinador de proyectos',
        estilo: 'organizado, menciona tiempos',
      };
    if (r < 0.35) return { perfil: 'Contador/Administrador', estilo: 'enfocado en detalles' };
    if (r < 0.4)
      return {
        perfil: 'Persona de compras',
        estilo: 'sabe que quiere, pregunta condiciones',
      };
    if (r < 0.45) return { perfil: 'Director/Socio', estilo: 'tono seguro, breve' };
    if (r < 0.5)
      return { perfil: 'Freelancer/Consultor', estilo: 'informal pero profesional' };
    if (r < 0.55) return { perfil: 'Responsable RRHH', estilo: 'amable, explica contexto' };
    if (r < 0.6) return { perfil: 'Persona de operaciones', estilo: 'practica, enfocada' };
    if (r < 0.65) return { perfil: 'Encargado de sucursal', estilo: 'cercano, concreto' };
    if (r < 0.7)
      return {
        perfil: 'Profesionista independiente',
        estilo: 'culto pero accesible',
      };
    if (r < 0.75) return { perfil: 'Responsable TI/Sistemas', estilo: 'tecnico, claro' };
    if (r < 0.8) return { perfil: 'Marketing/Comunicacion', estilo: 'creativo, objetivo claro' };
    if (r < 0.85)
      return {
        perfil: 'Logistica/Distribucion',
        estilo: 'muy concreto, tiempos y cantidades',
      };
    if (r < 0.9)
      return {
        perfil: 'Dueno empresa familiar',
        estilo: 'mezcla personal y profesional',
      };
    if (r < 0.95)
      return {
        perfil: 'Responsable calidad/cumplimiento',
        estilo: 'metodico, estandares',
      };
    return { perfil: 'Referido por conocido', estilo: 'lo menciona al inicio' };
  }

  private getOpening(r: number): string {
    if (r < 0.055) return 'Buen dia';
    if (r < 0.11) return 'Espero se encuentre bien';
    if (r < 0.165) return 'Les escribo porque';
    if (r < 0.22) return 'Me comunico con ustedes para';
    if (r < 0.275) return 'Nos contactamos';
    if (r < 0.33) return 'Vi su informacion y me intereso';
    if (r < 0.385) return 'Me recomendaron con ustedes';
    if (r < 0.44) return 'Tenemos una necesidad puntual';
    if (r < 0.495) return 'Estamos buscando apoyo';
    if (r < 0.55) return 'Quisiera saber si manejan';
    if (r < 0.605) return 'Hola, buen dia. Necesito cotizar';
    if (r < 0.66) return 'Por este medio me permito contactarlos';
    if (r < 0.715) return 'Reciban un cordial saludo';
    if (r < 0.77) return 'Trabajo en esta area y requerimos';
    if (r < 0.825) return 'Tengo una duda sobre su servicio';
    if (r < 0.88) return 'Oportunidad de colaboracion';
    if (r < 0.935) return 'Estamos en proceso de contratar';
    return 'Sin saludo formal, directo';
  }

  private getStructure(r: number): string {
    if (r < 0.09) return 'un_parrafo';
    if (r < 0.18) return 'dos_oraciones';
    if (r < 0.27) return 'pregunta_luego_pide';
    if (r < 0.36) return 'contexto_minimo';
    if (r < 0.45) return 'necesidad_pura';
    if (r < 0.54) return 'anecdota_rapida';
    if (r < 0.63) return 'muy_al_grano';
    if (r < 0.72) return 'menciona_urgencia';
    if (r < 0.81) return 'pregunta_especifica';
    return 'propuesta_directa';
  }

  private getTone(r: number): { tono: string; expresion: string } {
    if (r < 0.1) {
      return { tono: 'muy formal', expresion: 'Con gusto, de antemano gracias' };
    }
    if (r < 0.2) {
      return { tono: 'formal con calidez', expresion: 'Quedo a sus ordenes' };
    }
    if (r < 0.3) {
      return { tono: 'semiformal natural', expresion: 'sin protocolo excesivo' };
    }
    if (r < 0.4) {
      return { tono: 'directo amigable', expresion: 'tutea sin perder respeto' };
    }
    if (r < 0.5) {
      return { tono: 'relajado pero serio', expresion: "Usa 'oye', 'les comento'" };
    }
    if (r < 0.6) {
      return { tono: 'coloquial profesional', expresion: 'Como platicar en persona' };
    }
    if (r < 0.7) {
      return { tono: 'calido con urgencia', expresion: 'Amable pero hay prisa' };
    }
    if (r < 0.8) {
      return { tono: 'muy breve', expresion: 'Sin floreos, lo necesario' };
    }
    if (r < 0.9) {
      return { tono: 'con humor ligero', expresion: 'seria un tipazo, ojala puedan' };
    }
    return { tono: 'respetuoso agradecido', expresion: 'Muy buena onda' };
  }

  private getLength(r: number): { extension: string; palabras: string } {
    if (r < 0.25) {
      return { extension: 'muy_corto', palabras: '1 parrafo breve (2 oraciones)' };
    }
    if (r < 0.5) {
      return { extension: 'corto', palabras: '1 parrafo natural' };
    }
    if (r < 0.75) {
      return { extension: 'medio', palabras: '1 o 2 parrafos corridos' };
    }
    return { extension: 'largo', palabras: '2 parrafos naturales, sin cortes por ancho' };
  }

  private getNaturalidad(r: number): { nivel: string; tips: string } {
    if (r < 0.25) {
      return {
        nivel: 'muy_formal',
        tips: 'Evita expresiones coloquiales. Usa vocabulario empresarial.',
      };
    }
    if (r < 0.5) {
      return {
        nivel: 'semiformal',
        tips: 'Mezcla profesionalismo con algo de naturalidad. Una frase casual esta bien.',
      };
    }
    if (r < 0.75) {
      return {
        nivel: 'conversacional',
        tips: 'Suena cercano y profesional. Frases cortas.',
      };
    }
    return {
      nivel: 'muy_natural',
      tips: 'Como platicando con un colega. Informal pero serio en lo que pide.',
    };
  }
}
