import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as ExcelJS from 'exceljs';
import { GmailOAuthService } from './gmail-oauth.service';
import { SqlService } from '../contracts/services/sql.service';
import { GoogleWorkspaceService } from '../contracts/services/google-workspace.service';
import { DeliverableClassifierService } from '../contracts/services/deliverable-classifier.service';
import { SystemErrorService } from '../common/system-error.service';

@Injectable()
export class GmailDetectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GmailDetectorService.name);
  private readonly seenMessageIds = new Set<string>();
  private readonly scheduledMessageIds = new Set<string>();
  private readonly pendingReplyTimers = new Map<string, NodeJS.Timeout>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private initialized = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly gmailOAuthService: GmailOAuthService,
    private readonly sqlService: SqlService,
    private readonly googleWorkspaceService: GoogleWorkspaceService,
    private readonly deliverableClassifier: DeliverableClassifierService,
    private readonly systemErrorService: SystemErrorService,
  ) {}

  onModuleInit() {
    const enabled =
      this.configService.get<string>('GMAIL_DETECTOR_ENABLED', 'true') === 'true';
    if (!enabled) {
      this.logger.log('Detector deshabilitado por config (GMAIL_DETECTOR_ENABLED=false)');
      return;
    }

    const intervalMs = Number(
      this.configService.get<string>('GMAIL_DETECT_INTERVAL_MS', '60000'),
    );
    const safeInterval = Number.isFinite(intervalMs)
      ? Math.max(15000, intervalMs)
      : 60000;
    const delayRange = this.getReplyDelayRangeMs();

    this.logger.log(
      `Detector Gmail activo. Intervalo: ${safeInterval}ms. Espera contestacion: ${Math.round(delayRange.minMs / 60000)}-${Math.round(delayRange.maxMs / 60000)} min`,
    );

    this.poll().catch((error) => {
      this.logger.error(`Error en sondeo inicial: ${(error as Error).message}`);
      void this.systemErrorService.notify({
        error,
        context: 'gmail-detector sondeo inicial',
        source: 'gmail-detector',
      });
    });

    this.timer = setInterval(() => {
      this.poll().catch((error) => {
        this.logger.error(`Error en sondeo programado: ${(error as Error).message}`);
        void this.systemErrorService.notify({
          error,
          context: 'gmail-detector sondeo programado',
          source: 'gmail-detector',
        });
      });
    }, safeInterval);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const [messageId, pendingTimer] of this.pendingReplyTimers.entries()) {
      clearTimeout(pendingTimer);
      this.pendingReplyTimers.delete(messageId);
      this.scheduledMessageIds.delete(messageId);
    }
  }

  private async poll() {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      const maxResults = Number(
        this.configService.get<string>('GMAIL_DETECT_MAX_RESULTS', '50'),
      );
      const safeMax = Number.isFinite(maxResults)
        ? Math.max(5, Math.min(maxResults, 100))
        : 50;

      const detection = await this.gmailOAuthService.detectInboxReplies(safeMax);
      const allMessages = [...detection.validReplies, ...detection.invalidReplies];
      const newMessages = allMessages.filter((m) => !this.seenMessageIds.has(m.messageId));

      if (!this.initialized) {
        const warmupSkipExisting =
          this.configService.get<string>('GMAIL_DETECT_WARMUP_SKIP_EXISTING', 'true') ===
          'true';
        if (warmupSkipExisting) {
          newMessages.forEach((m) => this.seenMessageIds.add(m.messageId));
          this.initialized = true;
          this.logger.log(
            `Warmup detector: ${newMessages.length} mensajes existentes marcados como leidos internamente.`,
          );
          return;
        }
        this.initialized = true;
      }

      if (!newMessages.length) {
        return;
      }

      newMessages.forEach((m) => this.seenMessageIds.add(m.messageId));
      const newValid = newMessages.filter((m) => m.valid);
      const newInvalid = newMessages.filter((m) => !m.valid);

      this.logger.log(
        `Nuevos mensajes detectados: ${newMessages.length} (validos=${newValid.length}, invalidos=${newInvalid.length})`,
      );

      for (const valid of newValid) {
        this.logger.log(
          `[VALID_REPLY] thread=${valid.threadId} from=${valid.fromEmail} subject="${valid.subject}" snippet="${valid.snippet}"`,
        );
        // Marca como leido apenas se detecta y valida; la contestacion espera 10-30 min.
        await this.markAsReadSafe(valid.messageId);
        this.scheduleValidReplyProcessing(valid);
      }

      for (const invalid of newInvalid) {
        this.logger.warn(
          `[INVALID_REPLY] thread=${invalid.threadId} from=${invalid.fromEmail} reason=${invalid.reason}`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  private scheduleValidReplyProcessing(reply: {
    messageId: string;
    threadId: string;
    fromEmail: string;
    subject: string;
  }): void {
    if (this.scheduledMessageIds.has(reply.messageId)) {
      this.logger.log(
        `[FLOW_SCHEDULE_SKIP] messageId=${reply.messageId} ya tiene contestacion programada.`,
      );
      return;
    }

    const delayMs = this.getRandomReplyDelayMs();
    const delayMin = Math.round(delayMs / 60000);
    this.scheduledMessageIds.add(reply.messageId);

    this.logger.log(
      `[FLOW_SCHEDULED] messageId=${reply.messageId} subject="${reply.subject}" espera=${delayMin} min (${delayMs}ms) antes de contestar.`,
    );

    const pendingTimer = setTimeout(() => {
      this.pendingReplyTimers.delete(reply.messageId);
      this.logger.log(
        `[FLOW_DELAY_DONE] messageId=${reply.messageId} iniciando contestacion tras espera programada.`,
      );
      this.startFlowForValidReply(reply)
        .catch((error) => {
          this.logger.error(
            `[FLOW_ERROR] messageId=${reply.messageId} contestacion diferida: ${(error as Error).message}`,
          );
          void this.systemErrorService.notify({
            error,
            folioDigital: this.systemErrorService.extractFolioFromText(reply.subject),
            context: `contestacion diferida messageId=${reply.messageId} subject="${reply.subject}"`,
            source: 'gmail-detector',
          });
        })
        .finally(() => {
          this.scheduledMessageIds.delete(reply.messageId);
        });
    }, delayMs);

    this.pendingReplyTimers.set(reply.messageId, pendingTimer);
  }

  private getReplyDelayRangeMs(): { minMs: number; maxMs: number } {
    const minMs = Number(
      this.configService.get<string>('GMAIL_REPLY_DELAY_MIN_MS', String(10 * 60 * 1000)),
    );
    const maxMs = Number(
      this.configService.get<string>('GMAIL_REPLY_DELAY_MAX_MS', String(30 * 60 * 1000)),
    );
    const safeMin = Number.isFinite(minMs) ? Math.max(0, Math.trunc(minMs)) : 10 * 60 * 1000;
    const safeMax = Number.isFinite(maxMs) ? Math.max(safeMin, Math.trunc(maxMs)) : 30 * 60 * 1000;
    return { minMs: safeMin, maxMs: safeMax };
  }

  private getRandomReplyDelayMs(): number {
    const { minMs, maxMs } = this.getReplyDelayRangeMs();
    if (maxMs <= minMs) {
      return minMs;
    }
    return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  }

  private async startFlowForValidReply(reply: {
    messageId: string;
    threadId: string;
    fromEmail: string;
    subject: string;
  }) {
    let lockKey = '';
    let lockAcquired = false;
    try {
      const route = this.resolveRouteFromSubject(reply.subject);
      const folio = route?.folio;
      if (!folio) {
        this.logger.log(
          `[FLOW_SKIP] messageId=${reply.messageId} sin coincidencia de folio/sufijo controlado en subject.`,
        );
        return;
      }

      const track = await this.sqlService.getContractTrackStatus(folio);
      if (track.isCancelado) {
        await this.sendCancellationNotice({
          to: reply.fromEmail,
          subject: reply.subject,
          folio,
        });
        this.logger.warn(
          `[FLOW_SKIP] folio=${folio} cancelado (isCancelado=1). No se procesa respuesta OS.`,
        );
        return;
      }
      if (track.hasEtapa15 || track.hasEtapa16) {
        this.logger.warn(
          `[FLOW_SKIP] folio=${folio} contiene etapa 15/16 (bitacora/cancelacion). No se procesa flujo de correos.`,
        );
        return;
      }

      // Hilo de entregables: asunto {folio}-ET (legacy: solo folio).
      // Si el solicitante responde ahi con el pago (porque los entregables
      // llegaron antes de contestar la factura -OS-FAC-INT), se reconoce
      // como la misma transicion de pago del carril (etapas 8/9).
      // También aplica si responde al aviso de "no detectamos pago" (mismo -ET).
      let effectiveMarker = route.marker;
      if (!effectiveMarker || effectiveMarker === '-ET') {
        const pagoMarker = await this.resolvePagoSolicitanteFromEntregablesThread({
          reply,
          folio,
          track,
          routeMarker: effectiveMarker,
        });
        if (!pagoMarker) {
          return;
        }
        effectiveMarker = pagoMarker;
        this.logger.log(
          `[FLOW_ROUTE] folio=${folio} pago de solicitante detectado en hilo de entregables; se aplica marker=${effectiveMarker}`,
        );
      }

      // Ejecutora puede responder a -OS (factura temprana / entregables) o a
      // -OS-PAGO-INT (ultimo correo de pago) con entregables. Siempre se lee
      // el contenido completo y luego se decide con etapas + clasificacion.
      if (effectiveMarker === '-OS' || effectiveMarker === '-OS-PAGO-INT') {
        const contract = await this.sqlService.getContractByFolio(folio);
        const fromEmail = (reply.fromEmail || '').toLowerCase().trim();
        const ejecutoraEmail = (contract.contrato.email_ejecutora || '').toLowerCase().trim();

        if (ejecutoraEmail && fromEmail === ejecutoraEmail) {
          const decision = await this.resolveEjecutoraReplyDecision({
            reply,
            folio,
            marker: effectiveMarker,
            track,
          });

          if (decision.action === 'entregables') {
            await this.handleOsEntregablesReply({
              reply,
              folio,
              track,
              contract,
              entryMarker: effectiveMarker,
            });
            return;
          }

          if (decision.action === 'factura_os') {
            // Continua al flujo secuencial de factura (-OS → etapas 4/5).
          } else {
            this.logger.warn(
              `[FLOW_SKIP] folio=${folio} marker=${effectiveMarker} decision=${decision.action} razon="${decision.reason}"`,
            );
            return;
          }
        } else if (effectiveMarker === '-OS-PAGO-INT') {
          // -OS-PAGO-INT no tiene transicion de entrada en carril pagos;
          // solo ejecutora puede usarlo (entregables). Otros remitentes: skip.
          this.logger.log(
            `[FLOW_SKIP] folio=${folio} marker=-OS-PAGO-INT remitente no es ejecutora.`,
          );
          return;
        }
      }

      const transition = this.getTransitionByMarker(effectiveMarker);
      if (!transition) {
        this.logger.log(
          `[FLOW_SKIP] folio=${folio} marker=${effectiveMarker} sin transicion configurada.`,
        );
        return;
      }

      lockKey = `cocei-flow-${folio}-${transition.incomingMarker}`;
      lockAcquired = await this.sqlService.acquireFlowLock(lockKey, 0);
      if (!lockAcquired) {
        this.logger.warn(
          `[FLOW_SKIP] folio=${folio} marker=${transition.incomingMarker} lock no disponible (otro proceso en ejecucion).`,
        );
        return;
      }

      if (transition.incomingMarker === '-OS') {
        if (track.latestEtapa !== transition.expectedLatestEtapa) {
          this.logger.warn(
            `[FLOW_SKIP] folio=${folio} etapa reciente=${track.latestEtapa}. Se requiere=${transition.expectedLatestEtapa} para factura ejecutora.`,
          );
          return;
        }
      } else if (track.paymentTrackLatest !== transition.expectedLatestEtapa) {
        this.logger.warn(
          `[FLOW_SKIP] folio=${folio} etapa reciente carril pagos=${track.paymentTrackLatest}. Se requiere=${transition.expectedLatestEtapa}.`,
        );
        return;
      }

      const contract = await this.sqlService.getContractByFolio(folio);
      const incomingEmlName = `${folio}-${transition.senderRole}-concentradora.eml`;
      const outgoingEmlName = `${folio}-concentradora-${transition.targetRole}.eml`;

      const alreadyReceived = await this.sqlService.hasContractDetailByDocumentName({
        idContrato: track.idContrato,
        idEtapa: transition.receiveEtapa,
        documentName: incomingEmlName,
      });
      const alreadySent = await this.sqlService.hasContractDetailByDocumentName({
        idContrato: track.idContrato,
        idEtapa: transition.sendEtapa,
        documentName: outgoingEmlName,
      });
      if (alreadyReceived || alreadySent) {
        this.logger.warn(
          `[FLOW_SKIP] folio=${folio} marker=${transition.incomingMarker} ya registrado (receive=${alreadyReceived}, send=${alreadySent}).`,
        );
        return;
      }

      const expectedSender = this.getEmailByRole(contract, transition.senderRole);
      const fromEmail = (reply.fromEmail || '').toLowerCase().trim();
      if (expectedSender && fromEmail !== expectedSender) {
        this.logger.warn(
          `[FLOW_SKIP] messageId=${reply.messageId} remitente ${fromEmail} no coincide con esperado ${expectedSender} (${transition.senderRole}).`,
        );
        return;
      }

      const folderId =
        contract.contrato.iddrive ||
        this.configService.get<string>('GOOGLE_DRIVE_PARENT_FOLDER_ID', '');
      if (!folderId) {
        this.logger.error(
          `[FLOW_ERROR] messageId=${reply.messageId} sin folderId de Drive para folio ${folio}.`,
        );
        void this.systemErrorService.notify({
          error: `Sin folderId de Drive para folio ${folio}`,
          folioDigital: folio,
          context: `flujo marker=${transition.incomingMarker} sin folderId`,
          source: 'gmail-detector',
        });
        return;
      }

      const incomingEml = await this.gmailOAuthService.downloadMessageAsEml(reply.messageId);
      const incomingEmlUpload = await this.googleWorkspaceService.uploadEml({
        folderId,
        fileName: incomingEmlName,
        emlBuffer: incomingEml,
      });

      const context = await this.gmailOAuthService.getMessageContext(reply.messageId);
      const attachments = await this.gmailOAuthService.getMessageAttachments(reply.messageId);
      if (!attachments.length) {
        await this.sendMissingAttachmentsNotice({
          to: reply.fromEmail,
          subject: reply.subject,
          folio,
          expectedType: transition.attachmentBaseName,
        });
        this.logger.warn(
          `[FLOW_SKIP] folio=${folio} marker=${transition.incomingMarker} sin adjuntos. Se solicito reenvio con adjuntos.`,
        );
        return;
      }

      const forwardedAttachments: Array<{
        filename: string;
        mimeType: string;
        buffer: Buffer;
      }> = [];
      const receivedDriveDocs: Array<{ name: string; url: string }> = [
        {
          name: incomingEmlUpload.name,
          url: incomingEmlUpload.webViewLink,
        },
      ];
      const extensionCounters = new Map<string, number>();

      for (const attachment of attachments) {
        const ext = this.resolveAttachmentExtension(attachment.extension, attachment.mimeType);
        const currentCount = (extensionCounters.get(ext) ?? 0) + 1;
        extensionCounters.set(ext, currentCount);
        const suffix = currentCount > 1 ? `_${currentCount}` : '';
        const fileName = `${folio}_${transition.attachmentBaseName}${suffix}${ext}`;

        const uploaded = await this.googleWorkspaceService.uploadFile({
          folderId,
          fileName,
          buffer: attachment.buffer,
          mimeType: attachment.mimeType || 'application/octet-stream',
        });
        receivedDriveDocs.push({ name: uploaded.name, url: uploaded.webViewLink });

        forwardedAttachments.push({
          filename: fileName,
          mimeType: attachment.mimeType || 'application/octet-stream',
          buffer: attachment.buffer,
        });
      }

      await this.sqlService.insertContractDetail({
        idContrato: track.idContrato,
        idEtapa: transition.receiveEtapa,
        nomDocumento: receivedDriveDocs.map((d) => d.name).join(','),
        urlDocumento: receivedDriveDocs.map((d) => d.url).join(','),
      });

      const forwardSubject = `${folio}${transition.outgoingSubjectSuffix}`;
      const forwardMessage = this.extractLatestReplyText(
        context.textBody || context.snippet || '',
      );

      const targetEmail = this.getEmailByRole(contract, transition.targetRole);
      if (!targetEmail) {
        this.logger.error(
          `[FLOW_ERROR] folio=${folio} sin correo destino para rol ${transition.targetRole}.`,
        );
        void this.systemErrorService.notify({
          error: `Sin correo destino para rol ${transition.targetRole}`,
          folioDigital: folio,
          context: `flujo marker=${transition.incomingMarker} sin email destino`,
          source: 'gmail-detector',
        });
        return;
      }

      const sent = await this.gmailOAuthService.sendMailWithAttachments({
        to: targetEmail,
        subject: forwardSubject,
        message: forwardMessage,
        attachments: forwardedAttachments,
      });

      const sentEmlUpload = await this.googleWorkspaceService.uploadEml({
        folderId,
        fileName: outgoingEmlName,
        emlBuffer: sent.emlBuffer,
      });

      const sentDocs: Array<{ name: string; url: string }> = [
        {
          name: sentEmlUpload.name,
          url: sentEmlUpload.webViewLink,
        },
      ];
      if (forwardedAttachments.length) {
        sentDocs.push(
          ...receivedDriveDocs.filter((doc) => !doc.name.toLowerCase().endsWith('.eml')),
        );
      }

      await this.sqlService.insertContractDetail({
        idContrato: track.idContrato,
        idEtapa: transition.sendEtapa,
        nomDocumento: sentDocs.map((d) => d.name).join(','),
        urlDocumento: sentDocs.map((d) => d.url).join(','),
      });

      await this.tryGenerateBitacoraIfComplete({
        folio,
        idContrato: track.idContrato,
        folderId,
        contract,
      });

      this.logger.log(
        `[FLOW_TRIGGER] folio=${folio} etapa_recibe=${transition.receiveEtapa} etapa_envia=${transition.sendEtapa} reenviado_a=${targetEmail} adjuntos=${forwardedAttachments.length}`,
      );
    } catch (error) {
      this.logger.error(
        `[FLOW_ERROR] messageId=${reply.messageId} ${(error as Error).message}`,
      );
      void this.systemErrorService.notify({
        error,
        folioDigital: this.systemErrorService.extractFolioFromText(reply.subject),
        context: `startFlowForValidReply messageId=${reply.messageId}`,
        source: 'gmail-detector',
      });
    } finally {
      if (lockAcquired && lockKey) {
        try {
          await this.sqlService.releaseFlowLock(lockKey);
        } catch (releaseError) {
          this.logger.error(
            `[FLOW_LOCK_RELEASE_ERROR] messageId=${reply.messageId} ${(releaseError as Error).message}`,
          );
        }
      }
    }
  }

  private async resolveEjecutoraReplyDecision(params: {
    reply: {
      messageId: string;
      threadId: string;
      fromEmail: string;
      subject: string;
    };
    folio: string;
    marker: string;
    track: Awaited<ReturnType<SqlService['getContractTrackStatus']>>;
  }): Promise<{
    action: 'entregables' | 'factura_os' | 'skip';
    reason: string;
  }> {
    const { reply, folio, marker, track } = params;

    if (track.deliverablesComplete && marker === '-OS-PAGO-INT') {
      return {
        action: 'skip',
        reason: 'entregables ya completos; reply a -OS-PAGO-INT omitido',
      };
    }

    if (marker === '-OS-PAGO-INT' && !track.paymentTrackComplete) {
      return {
        action: 'skip',
        reason: 'reply a -OS-PAGO-INT sin etapa 11; hilo de pago aun no valido',
      };
    }

    const context = await this.gmailOAuthService.getMessageContext(reply.messageId);
    const attachments = await this.gmailOAuthService.getMessageAttachments(reply.messageId);

    if (!attachments.length) {
      const expectedType =
        !track.hasFacturaEjecutoraReceived && marker === '-OS'
          ? 'factura_ejecutora'
          : 'Entregable';
      await this.sendMissingAttachmentsNotice({
        to: reply.fromEmail,
        subject: reply.subject,
        folio,
        expectedType,
      });
      return {
        action: 'skip',
        reason: 'sin adjuntos; se solicito reenvio',
      };
    }

    const classification = await this.deliverableClassifier.classifyContent({
      folio,
      subject: reply.subject,
      bodyText: context.textBody || context.snippet || '',
      attachments,
    });

    this.logger.log(
      `[CONTENT_IA] folio=${folio} marker=${marker} tipo=${classification.tipo} confianza=${classification.confianza} source=${classification.source} razon="${classification.razon}"`,
    );

    // Entregables: desde etapa 4 en adelante, en -OS o -OS-PAGO-INT.
    if (classification.tipo === 'entregable') {
      if (!track.hasFacturaEjecutoraReceived) {
        await this.sendContentMismatchNotice({
          to: reply.fromEmail,
          subject: reply.subject,
          folio,
          message:
            'Recibimos posibles entregables, pero aun no esta registrada la factura de ejecutora para este folio. Primero envie la factura respondiendo a la Orden de Servicio; despues podra enviar los entregables.',
        });
        return {
          action: 'skip',
          reason: 'entregable detectado antes de etapa 4',
        };
      }
      if (track.deliverablesComplete) {
        return {
          action: 'skip',
          reason: 'entregables ya registrados (etapa 14)',
        };
      }
      return {
        action: 'entregables',
        reason: `contenido=entregable via ${marker}`,
      };
    }

    // Factura temprana solo en hilo -OS antes de etapa 4.
    if (
      marker === '-OS' &&
      classification.tipo === 'factura' &&
      !track.hasFacturaEjecutoraReceived &&
      track.latestEtapa === 3
    ) {
      return {
        action: 'factura_os',
        reason: 'factura de ejecutora en ventana etapa 3',
      };
    }

    // Fallos humanos: contenido que no encaja con la ventana actual.
    if (marker === '-OS' && !track.hasFacturaEjecutoraReceived) {
      await this.sendContentMismatchNotice({
        to: reply.fromEmail,
        subject: reply.subject,
        folio,
        message:
          'Recibimos su respuesta a la Orden de Servicio, pero el contenido no corresponde a la factura esperada. Por favor reenvie este mismo correo con la factura (PDF y XML si aplica).',
      });
      return {
        action: 'skip',
        reason: `se esperaba factura; contenido=${classification.tipo}`,
      };
    }

    if (track.hasFacturaEjecutoraReceived && !track.deliverablesComplete) {
      await this.sendContentMismatchNotice({
        to: reply.fromEmail,
        subject: reply.subject,
        folio,
        message:
          'Recibimos su respuesta, pero los adjuntos no fueron identificados como entregables del servicio. Por favor reenvie evidencias o documentos de entrega (fotos, reportes, actas o PDFs de avance).',
      });
      return {
        action: 'skip',
        reason: `ventana entregables; contenido=${classification.tipo} no_aplica`,
      };
    }

    return {
      action: 'skip',
      reason: `sin ruta valida para tipo=${classification.tipo} marker=${marker} etapa4=${track.hasFacturaEjecutoraReceived}`,
    };
  }

  private async handleOsEntregablesReply(params: {
    reply: {
      messageId: string;
      threadId: string;
      fromEmail: string;
      subject: string;
    };
    folio: string;
    track: Awaited<ReturnType<SqlService['getContractTrackStatus']>>;
    contract: Awaited<ReturnType<SqlService['getContractByFolio']>>;
    entryMarker?: string;
  }): Promise<void> {
    const lockKey = `cocei-flow-${params.folio}-OS-ENTREGABLES`;
    let lockAcquired = false;
    const entry = params.entryMarker || '-OS';

    try {
      lockAcquired = await this.sqlService.acquireFlowLock(lockKey, 0);
      if (!lockAcquired) {
        this.logger.warn(
          `[FLOW_SKIP] folio=${params.folio} entregables OS lock no disponible.`,
        );
        return;
      }

      const incomingEmlName = `${params.folio}-ejecutora-concentradora-entregable.eml`;
      const outgoingEmlNameIntegradora = `${params.folio}-concentradora-integradora-entregable.eml`;
      const outgoingEmlNameSolicitante = `${params.folio}-concentradora-solicitante-entregable.eml`;

      const alreadyReceived = await this.sqlService.hasContractDetailByDocumentName({
        idContrato: params.track.idContrato,
        idEtapa: 12,
        documentName: incomingEmlName,
      });
      const alreadySentIntegradora = await this.sqlService.hasContractDetailByDocumentName({
        idContrato: params.track.idContrato,
        idEtapa: 13,
        documentName: outgoingEmlNameIntegradora,
      });
      const alreadySentSolicitante = await this.sqlService.hasContractDetailByDocumentName({
        idContrato: params.track.idContrato,
        idEtapa: 14,
        documentName: outgoingEmlNameSolicitante,
      });
      if (alreadyReceived || alreadySentIntegradora || alreadySentSolicitante) {
        this.logger.warn(
          `[FLOW_SKIP] folio=${params.folio} entregables OS ya registrados.`,
        );
        return;
      }

      const folderId =
        params.contract.contrato.iddrive ||
        this.configService.get<string>('GOOGLE_DRIVE_PARENT_FOLDER_ID', '');
      if (!folderId) {
        this.logger.error(
          `[FLOW_ERROR] folio=${params.folio} sin folderId de Drive para entregables.`,
        );
        void this.systemErrorService.notify({
          error: `Sin folderId de Drive para entregables folio ${params.folio}`,
          folioDigital: params.folio,
          context: 'entregables sin folderId',
          source: 'gmail-detector',
        });
        return;
      }

      const context = await this.gmailOAuthService.getMessageContext(params.reply.messageId);
      const attachments = await this.gmailOAuthService.getMessageAttachments(
        params.reply.messageId,
      );
      if (!attachments.length) {
        await this.sendMissingAttachmentsNotice({
          to: params.reply.fromEmail,
          subject: params.reply.subject,
          folio: params.folio,
          expectedType: 'Entregable',
        });
        this.logger.warn(
          `[FLOW_SKIP] folio=${params.folio} entregables OS sin adjuntos.`,
        );
        return;
      }

      // La clasificacion OCR/IA ya ocurrio en resolveEjecutoraReplyDecision.
      this.logger.log(
        `[ENTREGABLE_FLOW] folio=${params.folio} entry=${entry} adjuntos=${attachments.length}`,
      );

      const incomingEml = await this.gmailOAuthService.downloadMessageAsEml(
        params.reply.messageId,
      );
      const incomingEmlUpload = await this.googleWorkspaceService.uploadEml({
        folderId,
        fileName: incomingEmlName,
        emlBuffer: incomingEml,
      });

      const forwardedAttachments: Array<{
        filename: string;
        mimeType: string;
        buffer: Buffer;
      }> = [];
      const receivedDriveDocs: Array<{ name: string; url: string }> = [
        {
          name: incomingEmlUpload.name,
          url: incomingEmlUpload.webViewLink,
        },
      ];
      const extensionCounters = new Map<string, number>();

      for (const attachment of attachments) {
        const ext = this.resolveAttachmentExtension(attachment.extension, attachment.mimeType);
        const currentCount = (extensionCounters.get(ext) ?? 0) + 1;
        extensionCounters.set(ext, currentCount);
        const suffix = currentCount > 1 ? `_${currentCount}` : '';
        const fileName = `${params.folio}_Entregable${suffix}${ext}`;

        const uploaded = await this.googleWorkspaceService.uploadFile({
          folderId,
          fileName,
          buffer: attachment.buffer,
          mimeType: attachment.mimeType || 'application/octet-stream',
        });
        receivedDriveDocs.push({ name: uploaded.name, url: uploaded.webViewLink });
        forwardedAttachments.push({
          filename: fileName,
          mimeType: attachment.mimeType || 'application/octet-stream',
          buffer: attachment.buffer,
        });
      }

      await this.sqlService.insertContractDetail({
        idContrato: params.track.idContrato,
        idEtapa: 12,
        nomDocumento: receivedDriveDocs.map((d) => d.name).join(','),
        urlDocumento: receivedDriveDocs.map((d) => d.url).join(','),
      });

      const forwardMessage = this.extractLatestReplyText(
        context.textBody || context.snippet || '',
      );

      const integradoraEmail = this.getEmailByRole(params.contract, 'integradora');
      if (!integradoraEmail) {
        this.logger.error(
          `[FLOW_ERROR] folio=${params.folio} sin correo destino para integradora.`,
        );
        void this.systemErrorService.notify({
          error: `Sin correo destino para integradora folio ${params.folio}`,
          folioDigital: params.folio,
          context: 'entregables sin email integradora',
          source: 'gmail-detector',
        });
        return;
      }

      const entregablesSubject = this.buildEntregablesSubject(params.folio);
      const sentIntegradora = await this.gmailOAuthService.sendMailWithAttachments({
        to: integradoraEmail,
        subject: entregablesSubject,
        message: forwardMessage,
        attachments: forwardedAttachments,
      });

      const sentEmlIntegradora = await this.googleWorkspaceService.uploadEml({
        folderId,
        fileName: outgoingEmlNameIntegradora,
        emlBuffer: sentIntegradora.emlBuffer,
      });

      const sentDocsIntegradora: Array<{ name: string; url: string }> = [
        {
          name: sentEmlIntegradora.name,
          url: sentEmlIntegradora.webViewLink,
        },
        ...receivedDriveDocs.filter((doc) => !doc.name.toLowerCase().endsWith('.eml')),
      ];

      await this.sqlService.insertContractDetail({
        idContrato: params.track.idContrato,
        idEtapa: 13,
        nomDocumento: sentDocsIntegradora.map((d) => d.name).join(','),
        urlDocumento: sentDocsIntegradora.map((d) => d.url).join(','),
      });

      const solicitanteEmail = this.getEmailByRole(params.contract, 'solicitante');
      if (!solicitanteEmail) {
        this.logger.error(
          `[FLOW_ERROR] folio=${params.folio} sin correo destino para solicitante.`,
        );
        void this.systemErrorService.notify({
          error: `Sin correo destino para solicitante folio ${params.folio}`,
          folioDigital: params.folio,
          context: 'entregables sin email solicitante',
          source: 'gmail-detector',
        });
        return;
      }

      const sentSolicitante = await this.gmailOAuthService.sendMailWithAttachments({
        to: solicitanteEmail,
        subject: entregablesSubject,
        message: forwardMessage,
        attachments: forwardedAttachments,
      });

      const sentEmlSolicitante = await this.googleWorkspaceService.uploadEml({
        folderId,
        fileName: outgoingEmlNameSolicitante,
        emlBuffer: sentSolicitante.emlBuffer,
      });

      const sentDocsSolicitante: Array<{ name: string; url: string }> = [
        {
          name: sentEmlSolicitante.name,
          url: sentEmlSolicitante.webViewLink,
        },
        ...receivedDriveDocs.filter((doc) => !doc.name.toLowerCase().endsWith('.eml')),
      ];

      await this.sqlService.insertContractDetail({
        idContrato: params.track.idContrato,
        idEtapa: 14,
        nomDocumento: sentDocsSolicitante.map((d) => d.name).join(','),
        urlDocumento: sentDocsSolicitante.map((d) => d.url).join(','),
      });

      await this.tryGenerateBitacoraIfComplete({
        folio: params.folio,
        idContrato: params.track.idContrato,
        folderId,
        contract: params.contract,
      });

      this.logger.log(
        `[FLOW_TRIGGER] folio=${params.folio} entregables entry=${entry} etapas=12,13,14 adjuntos=${forwardedAttachments.length}`,
      );
    } catch (error) {
      this.logger.error(
        `[FLOW_ERROR] folio=${params.folio} entregables OS ${(error as Error).message}`,
      );
      void this.systemErrorService.notify({
        error,
        folioDigital: params.folio,
        context: `handleOsEntregablesReply entry=${params.entryMarker || '-OS'}`,
        source: 'gmail-detector',
      });
    } finally {
      if (lockAcquired) {
        try {
          await this.sqlService.releaseFlowLock(lockKey);
        } catch (releaseError) {
          this.logger.error(
            `[FLOW_LOCK_RELEASE_ERROR] folio=${params.folio} entregables OS ${(releaseError as Error).message}`,
          );
        }
      }
    }
  }

  /** Asunto de reenvio de entregables: {folio}-ET */
  private buildEntregablesSubject(folio: string): string {
    return `${folio}-ET`;
  }

  /**
   * Mantiene la ancla del hilo al que respondio el solicitante:
   * -ET (nuevo), solo folio (legacy) o el aviso de reintento.
   */
  private resolveEntregablesPagoAnchorSubject(replySubject: string, folio: string): string {
    const source = String(replySubject || '').toUpperCase();
    if (source.includes(`${folio}-ET`)) {
      return `${folio}-ET`;
    }
    // Correos viejos de entregables salieron solo con el folio.
    return folio;
  }

  /**
   * Asunto con marcador (-OS, -OS-FAC-INT, -ET, ...) o solo folio (legacy entregables).
   * marker=null = hilo legacy de entregables / sin sufijo controlado.
   */
  private resolveRouteFromSubject(
    subject: string,
  ): { folio: string; marker: string | null } | null {
    const source = String(subject || '').toUpperCase();
    const folioMatch = source.match(/\b(\d{2}-[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{5,6}-\d{5})\b/);
    const folio = folioMatch?.[1] ?? '';
    if (!folio) {
      return null;
    }

    const markers = [
      '-OS-PAGO-INT',
      '-OS-PAGO-SOL',
      '-OS-FAC-INT',
      '-OS-FAC-EJ',
      '-OS',
      '-ET',
    ];
    const marker =
      markers.find((candidate) => source.includes(`${folio}${candidate}`)) ?? null;
    return { folio, marker };
  }

  /**
   * Si el solicitante responde al correo de entregables ({folio}-ET o solo folio)
   * con el comprobante de pago, y el carril de pagos esta en etapa 7, se trata
   * como -OS-FAC-INT. Si no hay adjuntos o el OCR/IA no detecta pago, se le
   * reenvia aviso con el mismo asunto-ancla (y adjuntos recibidos si hubo).
   */
  private async resolvePagoSolicitanteFromEntregablesThread(params: {
    reply: {
      messageId: string;
      threadId: string;
      fromEmail: string;
      subject: string;
    };
    folio: string;
    track: Awaited<ReturnType<SqlService['getContractTrackStatus']>>;
    routeMarker?: string | null;
  }): Promise<'-OS-FAC-INT' | null> {
    const { reply, folio, track } = params;
    const anchorSubject = this.resolveEntregablesPagoAnchorSubject(reply.subject, folio);

    if (track.paymentTrackLatest !== 7) {
      this.logger.log(
        `[FLOW_SKIP] folio=${folio} hilo entregables (${params.routeMarker || 'LEGACY'}); carril pagos=${track.paymentTrackLatest} (se requiere 7 para pago de solicitante).`,
      );
      return null;
    }

    const contract = await this.sqlService.getContractByFolio(folio);
    const fromEmail = (reply.fromEmail || '').toLowerCase().trim();
    const solicitanteEmail = this.getEmailByRole(contract, 'solicitante');
    if (!solicitanteEmail || fromEmail !== solicitanteEmail) {
      this.logger.log(
        `[FLOW_SKIP] folio=${folio} hilo entregables; remitente no es solicitante.`,
      );
      return null;
    }

    const attachments = await this.gmailOAuthService.getMessageAttachments(reply.messageId);
    if (!attachments.length) {
      await this.sendSolicitantePagoRetryNotice({
        to: reply.fromEmail,
        subject: anchorSubject,
        folio,
        reason: 'sin_adjuntos',
        attachments: [],
      });
      this.logger.warn(
        `[FLOW_SKIP] folio=${folio} pago en hilo entregables sin adjuntos; se solicito reenvio en ${anchorSubject}.`,
      );
      return null;
    }

    // En este hilo el solicitante SOLO paga. No bloqueamos por OCR/IA:
    // si hay adjuntos + etapa 7 + remitente correcto, se registra el pago
    // igual que en -OS-FAC-INT. La clasificacion queda solo para logs.
    try {
      const context = await this.gmailOAuthService.getMessageContext(reply.messageId);
      const classification = await this.deliverableClassifier.classifyContent({
        folio,
        subject: reply.subject,
        bodyText: context.textBody || context.snippet || '',
        attachments,
      });
      this.logger.log(
        `[CONTENT_IA] folio=${folio} marker=${params.routeMarker || 'ET/LEGACY'} tipo=${classification.tipo} confianza=${classification.confianza} source=${classification.source} razon="${classification.razon}" (informativo; no bloquea pago solicitante)`,
      );
    } catch (error) {
      this.logger.warn(
        `[CONTENT_IA] folio=${folio} clasificacion informativa fallo: ${(error as Error).message}`,
      );
    }

    return '-OS-FAC-INT';
  }

  /**
   * Aviso al solicitante cuando en el ancla de entregables falta adjunto de pago.
   * Conserva el mismo asunto para que pueda responder al aviso o al correo previo.
   */
  private async sendSolicitantePagoRetryNotice(params: {
    to: string;
    subject: string;
    folio: string;
    reason: 'sin_adjuntos';
    attachments: Array<{ filename: string; mimeType: string; buffer: Buffer }>;
  }): Promise<void> {
    const to = String(params.to || '').trim().toLowerCase();
    if (!to) {
      return;
    }

    const message = `Se recibio su respuesta en el hilo de entregables del folio ${params.folio}, pero no contiene adjuntos. En este punto se espera su comprobante de pago. Por favor responda este mismo correo (o el anterior de entregables) adjuntando el comprobante de pago para continuar.`;

    try {
      await this.gmailOAuthService.sendMail({
        to,
        subject: params.subject,
        message,
      });
    } catch (error) {
      this.logger.warn(
        `[FLOW_WARN] no se pudo solicitar reenvio de pago a solicitante ${to}: ${(error as Error).message}`,
      );
    }
  }

  private getTransitionByMarker(marker: string):
    | {
        incomingMarker: string;
        expectedLatestEtapa: number;
        receiveEtapa: number;
        sendEtapa: number;
        senderRole: 'ejecutora' | 'integradora' | 'solicitante';
        targetRole: 'ejecutora' | 'integradora' | 'solicitante';
        attachmentBaseName:
          | 'factura_ejecutora'
          | 'factura_integradora'
          | 'pago_solicitante'
          | 'pago_integradora';
        outgoingSubjectSuffix:
          | '-OS-FAC-EJ'
          | '-OS-FAC-INT'
          | '-OS-PAGO-SOL'
          | '-OS-PAGO-INT';
      }
    | null {
    const transitions: Array<{
      incomingMarker: string;
      expectedLatestEtapa: number;
      receiveEtapa: number;
      sendEtapa: number;
      senderRole: 'ejecutora' | 'integradora' | 'solicitante';
      targetRole: 'ejecutora' | 'integradora' | 'solicitante';
      attachmentBaseName:
        | 'factura_ejecutora'
        | 'factura_integradora'
        | 'pago_solicitante'
        | 'pago_integradora';
      outgoingSubjectSuffix:
        | '-OS-FAC-EJ'
        | '-OS-FAC-INT'
        | '-OS-PAGO-SOL'
        | '-OS-PAGO-INT';
    }> = [
      {
        incomingMarker: '-OS',
        expectedLatestEtapa: 3,
        receiveEtapa: 4,
        sendEtapa: 5,
        senderRole: 'ejecutora',
        targetRole: 'integradora',
        attachmentBaseName: 'factura_ejecutora',
        outgoingSubjectSuffix: '-OS-FAC-EJ',
      },
      {
        incomingMarker: '-OS-FAC-EJ',
        expectedLatestEtapa: 5,
        receiveEtapa: 6,
        sendEtapa: 7,
        senderRole: 'integradora',
        targetRole: 'solicitante',
        attachmentBaseName: 'factura_integradora',
        outgoingSubjectSuffix: '-OS-FAC-INT',
      },
      {
        incomingMarker: '-OS-FAC-INT',
        expectedLatestEtapa: 7,
        receiveEtapa: 8,
        sendEtapa: 9,
        senderRole: 'solicitante',
        targetRole: 'integradora',
        attachmentBaseName: 'pago_solicitante',
        outgoingSubjectSuffix: '-OS-PAGO-SOL',
      },
      {
        incomingMarker: '-OS-PAGO-SOL',
        expectedLatestEtapa: 9,
        receiveEtapa: 10,
        sendEtapa: 11,
        senderRole: 'integradora',
        targetRole: 'ejecutora',
        attachmentBaseName: 'pago_integradora',
        outgoingSubjectSuffix: '-OS-PAGO-INT',
      },
    ];
    return transitions.find((transition) => transition.incomingMarker === marker) ?? null;
  }

  private getEmailByRole(
    contract: Awaited<ReturnType<SqlService['getContractByFolio']>>,
    role: 'ejecutora' | 'integradora' | 'solicitante',
  ): string {
    if (role === 'ejecutora') {
      return (contract.contrato.email_ejecutora || '').toLowerCase().trim();
    }
    if (role === 'integradora') {
      return (contract.contrato.email_integradora || '').toLowerCase().trim();
    }
    return (contract.solicitante.email || '').toLowerCase().trim();
  }

  private resolveAttachmentExtension(extension: string, mimeType: string): string {
    const ext = (extension || '').toLowerCase().trim();
    if (ext) {
      return ext.startsWith('.') ? ext : `.${ext}`;
    }
    const byMime: Record<string, string> = {
      'application/pdf': '.pdf',
      'application/xml': '.xml',
      'text/xml': '.xml',
      'text/plain': '.txt',
      'application/zip': '.zip',
    };
    return byMime[(mimeType || '').toLowerCase()] || '.bin';
  }

  private async markAsReadSafe(messageId: string): Promise<void> {
    try {
      await this.gmailOAuthService.markMessageAsRead(messageId);
    } catch (error) {
      this.logger.warn(
        `[FLOW_WARN] no se pudo marcar como leido messageId=${messageId}: ${(error as Error).message}`,
      );
    }
  }

  private async sendCancellationNotice(params: {
    to: string;
    subject: string;
    folio: string;
  }): Promise<void> {
    const to = String(params.to || '').trim().toLowerCase();
    if (!to) {
      return;
    }
    try {
      await this.gmailOAuthService.sendMail({
        to,
        subject: String(params.subject || params.folio || '').trim() || params.folio,
        message:
          'El proceso asociado a este folio ya fue cancelado. No se procesaran mas respuestas ni reenvios para este caso.',
      });
    } catch (error) {
      this.logger.warn(
        `[FLOW_WARN] no se pudo enviar aviso de cancelacion a ${to}: ${(error as Error).message}`,
      );
    }
  }

  private async sendMissingAttachmentsNotice(params: {
    to: string;
    subject: string;
    folio: string;
    expectedType:
      | 'factura_ejecutora'
      | 'factura_integradora'
      | 'pago_solicitante'
      | 'pago_integradora'
      | 'Entregable';
  }): Promise<void> {
    const to = String(params.to || '').trim().toLowerCase();
    if (!to) {
      return;
    }

    const expectedLabelByType: Record<typeof params.expectedType, string> = {
      factura_ejecutora: 'factura de ejecutora',
      factura_integradora: 'factura de integradora',
      pago_solicitante: 'comprobante de pago de solicitante',
      pago_integradora: 'comprobante de pago de integradora',
      Entregable: 'entregables',
    };
    const expectedLabel = expectedLabelByType[params.expectedType] || 'documentacion requerida';

    try {
      await this.gmailOAuthService.sendMail({
        to,
        subject: String(params.subject || '').trim() || params.folio,
        message: `Se recibio su respuesta, pero no contiene adjuntos. Por favor, reenvie este mismo correo con los adjuntos correspondientes a ${expectedLabel} para continuar con el proceso.`,
      });
    } catch (error) {
      this.logger.warn(
        `[FLOW_WARN] no se pudo solicitar adjuntos faltantes a ${to}: ${(error as Error).message}`,
      );
    }
  }

  private async sendContentMismatchNotice(params: {
    to: string;
    subject: string;
    folio: string;
    message: string;
  }): Promise<void> {
    const to = String(params.to || '').trim().toLowerCase();
    if (!to) {
      return;
    }
    try {
      await this.gmailOAuthService.sendMail({
        to,
        subject: String(params.subject || '').trim() || params.folio,
        message: params.message,
      });
    } catch (error) {
      this.logger.warn(
        `[FLOW_WARN] no se pudo notificar desajuste de contenido a ${to}: ${(error as Error).message}`,
      );
    }
  }

  private async tryGenerateBitacoraIfComplete(params: {
    folio: string;
    idContrato: number;
    folderId: string;
    contract: Awaited<ReturnType<SqlService['getContractByFolio']>>;
  }): Promise<void> {
    try {
      const track = await this.sqlService.getContractTrackStatus(params.folio);
      if (!track.paymentTrackComplete || !track.deliverablesComplete) {
        this.logger.log(
          `[BITACORA_WAIT] folio=${params.folio} pagos=${track.paymentTrackComplete} entregables=${track.deliverablesComplete}`,
        );
        return;
      }
      await this.generateAndStoreBitacora(params);
    } catch (error) {
      this.logger.error(
        `[BITACORA_ERROR] folio=${params.folio} ${(error as Error).message}`,
      );
      void this.systemErrorService.notify({
        error,
        folioDigital: params.folio,
        context: 'tryGenerateBitacoraIfComplete',
        source: 'gmail-detector',
      });
    }
  }

  private async generateAndStoreBitacora(params: {
    folio: string;
    idContrato: number;
    folderId: string;
    contract: Awaited<ReturnType<SqlService['getContractByFolio']>>;
  }): Promise<void> {
    const bitacoraTemplateId = this.configService.get<string>('GOOGLE_BITACORA_SHEET_ID', '');
    if (!bitacoraTemplateId) {
      this.logger.warn(`[BITACORA_SKIP] folio=${params.folio} sin GOOGLE_BITACORA_SHEET_ID.`);
      return;
    }

    const fileName = `${params.folio}_Bitacora.xlsx`;
    const alreadyGenerated = await this.sqlService.hasContractDetailByDocumentName({
      idContrato: params.idContrato,
      idEtapa: 15,
      documentName: fileName,
    });
    if (alreadyGenerated) {
      this.logger.warn(
        `[BITACORA_SKIP] folio=${params.folio} bitacora ya registrada en etapa 15.`,
      );
      return;
    }

    const timeline = await this.sqlService.getContractDetailTimeline(params.idContrato);
    const bitacoraBuffer = await this.buildBitacoraWorkbookBuffer({
      folio: params.folio,
      contract: params.contract,
      templateFileId: bitacoraTemplateId,
      timeline,
    });
    const uploaded = await this.googleWorkspaceService.uploadFile({
      folderId: params.folderId,
      fileName,
      buffer: bitacoraBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    await this.sqlService.insertContractDetail({
      idContrato: params.idContrato,
      idEtapa: 15,
      nomDocumento: uploaded.name,
      urlDocumento: uploaded.webViewLink,
    });

    const timelineWithBitacora = await this.sqlService.getContractDetailTimeline(
      params.idContrato,
    );
    const refreshedBuffer = await this.buildBitacoraWorkbookBuffer({
      folio: params.folio,
      contract: params.contract,
      templateFileId: bitacoraTemplateId,
      timeline: timelineWithBitacora,
    });

    await this.googleWorkspaceService.updateFile({
      fileId: uploaded.fileId,
      fileName: uploaded.name,
      buffer: refreshedBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    this.logger.log(
      `[BITACORA_OK] folio=${params.folio} etapa=15 archivo=${uploaded.name}`,
    );
  }

  private async buildBitacoraWorkbookBuffer(params: {
    folio: string;
    contract: Awaited<ReturnType<SqlService['getContractByFolio']>>;
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
    const templateBuffer = await this.googleWorkspaceService.downloadFileBuffer(
      params.templateFileId,
    );
    await workbook.xlsx.load(templateBuffer as unknown as any);
    const sheet = workbook.getWorksheet('Bitácora') ?? workbook.worksheets[0];
    if (!sheet) {
      throw new Error('No se encontro hoja de trabajo para generar bitacora.');
    }

    sheet.getCell('B3').value = params.folio;
    sheet.getCell('B5').value = params.contract.contrato.nom_servicio || '';
    sheet.getCell('B6').value = params.contract.solicitante.razon_social || '';
    sheet.getCell('B7').value = params.contract.integradora.razon_social || '';
    sheet.getCell('B8').value = params.contract.ejecutora.razon_social || '';
    sheet.getCell('A10').value = `DETALLE DE EVENTOS  (${params.timeline.length} registros)`;

    const startRow = 12;
    for (let i = 0; i < params.timeline.length; i += 1) {
      const rowNumber = startRow + i;
      const event = params.timeline[i];
      const date = this.normalizeDate(event.fechaDet);

      sheet.getCell(`A${rowNumber}`).value = this.formatDate(date);
      sheet.getCell(`B${rowNumber}`).value = this.formatTime(date);
      sheet.getCell(`C${rowNumber}`).value = event.nomEtapa;
      const documentCell = sheet.getCell(`D${rowNumber}`);
      documentCell.value = this.buildEventDocumentCell(event, event.idEtapa);
      documentCell.alignment = {
        ...(documentCell.alignment || {}),
        wrapText: true,
        vertical: 'top',
      };
    }

    const out = (await workbook.xlsx.writeBuffer()) as Buffer | ArrayBuffer;
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  }

  private buildEventDocumentCell(
    event: {
      idEtapa: number;
      nomDocumento: string;
      urlDocumento: string;
    },
    idEtapa: number,
  ): string {
    const names = String(event.nomDocumento || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const urls = String(event.urlDocumento || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

    if (idEtapa === 15) {
      const mainName = names[0] || 'Bitacora';
      const mainUrl = urls[0] || '';
      return mainUrl ? `${mainName}\n${mainUrl}` : mainName;
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
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private formatDate(date: Date | null): string {
    if (!date) {
      return '';
    }
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  private formatTime(date: Date | null): string {
    if (!date) {
      return '';
    }
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  private extractLatestReplyText(rawBody: string): string {
    const source = String(rawBody || '').replace(/\r\n/g, '\n');
    const cutPatterns: RegExp[] = [
      /(?:^|\n)\s*On[\s\S]{0,800}?\bwrote:\s*/i,
      /(?:^|\n)\s*El[\s\S]{0,800}?\bescribi[oó]:\s*/i,
      /(?:^|\n)\s*De:\s.+$/im,
      /(?:^|\n)\s*From:\s.+$/im,
      /(?:^|\n)\s*-{2,}\s*Original Message\s*-{2,}\s*$/im,
      /(?:^|\n)\s*Begin forwarded message:\s*$/im,
    ];

    let cutIndex = source.length;
    for (const pattern of cutPatterns) {
      const match = pattern.exec(source);
      if (match && typeof match.index === 'number') {
        cutIndex = Math.min(cutIndex, match.index);
      }
    }

    const candidate = source.slice(0, cutIndex);
    const cleaned = candidate
      .split('\n')
      .filter((line) => !line.trim().startsWith('>'))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (cleaned) {
      return cleaned;
    }
    return source.trim() || '(sin texto en cuerpo)';
  }
}
