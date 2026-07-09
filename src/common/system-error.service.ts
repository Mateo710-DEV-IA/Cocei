import { Injectable, Logger } from '@nestjs/common';
import { SqlService } from '../contracts/services/sql.service';

export interface SystemErrorInput {
  error: unknown;
  folioDigital?: string | null;
  context?: string;
  source?: string;
}

@Injectable()
export class SystemErrorService {
  private readonly logger = new Logger(SystemErrorService.name);
  private static readonly FOLIO_REGEX =
    /\b(\d{2}-[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{5,6}-\d{5})\b/i;

  constructor(private readonly sqlService: SqlService) {}

  async notify(params: SystemErrorInput): Promise<number | null> {
    try {
      const message = this.extractMessage(params.error);
      const stack = this.extractStack(params.error);
      const folio =
        this.normalizeFolio(params.folioDigital) ||
        this.extractFolioFromText(`${params.context || ''} ${message}`) ||
        'SYSTEM';

      const parties = folio !== 'SYSTEM' ? await this.sqlService.getPartyIdsByFolio(folio) : null;
      const resumen = this.buildResumen({
        source: params.source || 'system',
        context: params.context,
        message,
        stack,
      });

      const idError = await this.sqlService.insertSystemError({
        folioDigital: folio,
        resumenError: resumen,
        idSolicitante: parties?.idSolicitante ?? 0,
        idIntegradora: parties?.idIntegradora ?? 0,
        idEjecutora: parties?.idEjecutora ?? 0,
      });

      if (idError) {
        this.logger.warn(
          `[TAB_ERRORES] id_error=${idError} folio=${folio} source=${params.source || 'system'} msg="${message}"`,
        );
      } else {
        this.logger.error(
          `[TAB_ERRORES_FAIL] no se pudo insertar error folio=${folio} msg="${message}"`,
        );
      }
      return idError;
    } catch (notifyError) {
      this.logger.error(
        `[TAB_ERRORES_FAIL] ${(notifyError as Error).message}`,
      );
      return null;
    }
  }

  extractFolioFromText(value: string): string | null {
    const match = String(value || '').toUpperCase().match(SystemErrorService.FOLIO_REGEX);
    return match?.[1] ?? null;
  }

  private normalizeFolio(value?: string | null): string | null {
    const raw = String(value || '').trim().toUpperCase();
    if (!raw) {
      return null;
    }
    if (SystemErrorService.FOLIO_REGEX.test(raw)) {
      return raw.match(SystemErrorService.FOLIO_REGEX)?.[1] ?? raw.slice(0, 100);
    }
    return raw.slice(0, 100);
  }

  private extractMessage(error: unknown): string {
    if (!error) {
      return 'Error desconocido';
    }
    if (typeof error === 'string') {
      return error;
    }
    if (error instanceof Error) {
      return error.message || error.name || 'Error sin mensaje';
    }
    if (typeof error === 'object' && error !== null && 'message' in error) {
      return String((error as { message?: unknown }).message || 'Error sin mensaje');
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private extractStack(error: unknown): string {
    if (error instanceof Error && error.stack) {
      return error.stack;
    }
    return '';
  }

  private buildResumen(params: {
    source: string;
    context?: string;
    message: string;
    stack: string;
  }): string {
    const parts = [
      `[${params.source}]`,
      params.context ? `Contexto: ${params.context}` : '',
      `Error: ${params.message}`,
      params.stack ? `Stack: ${params.stack.split('\n').slice(0, 8).join(' | ')}` : '',
    ].filter(Boolean);
    return parts.join(' ').slice(0, 8000);
  }
}
