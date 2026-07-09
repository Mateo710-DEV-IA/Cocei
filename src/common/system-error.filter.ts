import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { SystemErrorService } from './system-error.service';

@Injectable()
@Catch()
export class SystemErrorFilter implements ExceptionFilter {
  constructor(private readonly systemErrorService: SystemErrorService) {}

  async catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // Solo notifica fallos reales (4xx/5xx de negocio o no controlados).
    // 404 de rutas inexistentes tambien se registran para trazabilidad.
    const folio = this.resolveFolio(request, exception);
    const context = `${request.method || 'HTTP'} ${request.url || ''}`.trim();

    await this.systemErrorService.notify({
      error: exception,
      folioDigital: folio,
      context,
      source: 'http',
    });

    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : null;
    const message =
      typeof exceptionResponse === 'string'
        ? exceptionResponse
        : typeof exceptionResponse === 'object' &&
            exceptionResponse !== null &&
            'message' in exceptionResponse
          ? (exceptionResponse as { message: string | string[] }).message
          : exception instanceof Error
            ? exception.message
            : 'Error interno del servidor';

    response.status(status).json({
      statusCode: status,
      message,
      error:
        exception instanceof HttpException
          ? exception.name.replace('Exception', '')
          : 'Internal Server Error',
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }

  private resolveFolio(request: Request, exception: unknown): string | null {
    const body = (request.body || {}) as Record<string, unknown>;
    const query = (request.query || {}) as Record<string, unknown>;
    const candidates = [
      body.folio_digital,
      body.folioDigital,
      body.folio,
      query.folio_digital,
      query.folioDigital,
      query.folio,
    ];

    for (const candidate of candidates) {
      const value = String(candidate || '').trim();
      if (value) {
        return value;
      }
    }

    const fromUrl = this.systemErrorService.extractFolioFromText(request.url || '');
    if (fromUrl) {
      return fromUrl;
    }

    const message =
      exception instanceof Error
        ? exception.message
        : typeof exception === 'string'
          ? exception
          : '';
    return this.systemErrorService.extractFolioFromText(message);
  }
}
