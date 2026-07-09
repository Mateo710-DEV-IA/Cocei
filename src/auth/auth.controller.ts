import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { GmailOAuthService } from './gmail-oauth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly gmailOAuthService: GmailOAuthService) {}

  @Get('gmail/start')
  startGmailOAuth() {
    return this.gmailOAuthService.createAuthUrl();
  }

  @Get('drive/start')
  startDriveOAuth() {
    return this.gmailOAuthService.createDriveAuthUrl();
  }

  @Get('gmail/callback')
  async gmailCallback(@Query('code') code?: string, @Query('state') state?: string) {
    if (!code) {
      throw new BadRequestException(
        'Falta query param "code". Abre /auth/gmail/start para iniciar OAuth.',
      );
    }

    const tokenData = await this.gmailOAuthService.exchangeCode(code);
    return {
      received_state: state ?? '',
      ...tokenData,
    };
  }

  @Get('drive/callback')
  async driveCallback(@Query('code') code?: string, @Query('state') state?: string) {
    if (!code) {
      throw new BadRequestException(
        'Falta query param "code". Abre /auth/drive/start para iniciar OAuth.',
      );
    }

    const tokenData = await this.gmailOAuthService.exchangeDriveCode(code);
    return {
      received_state: state ?? '',
      ...tokenData,
    };
  }

  @Post('gmail/send-test')
  async sendTestMail(@Query('to') to?: string) {
    if (!to) {
      throw new BadRequestException('Falta query param "to"');
    }

    const subject = `[COCEI TEST] RESPONDE ESTE CORREO ${Date.now()}`;
    const message =
      'Hola, este correo de prueba fue enviado desde la API Nest de COCEI.\n\nResponde este mismo hilo con el texto: OK RESPONDIDO.';

    return this.gmailOAuthService.sendMail({ to, subject, message });
  }

  @Get('gmail/thread/:threadId')
  getThread(@Param('threadId') threadId: string) {
    return this.gmailOAuthService.getThread(threadId);
  }

  @Get('gmail/replies/:threadId')
  getReplies(@Param('threadId') threadId: string) {
    return this.gmailOAuthService.getReplies(threadId);
  }

  @Get('gmail/inbox/detect')
  detectInboxReplies(
    @Query('maxResults') maxResults?: string,
    @Query('threadId') threadId?: string,
  ) {
    const parsed = Number(maxResults ?? '25');
    const safeMax = Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 100)) : 25;
    return this.gmailOAuthService.detectInboxReplies(safeMax, threadId);
  }
}
