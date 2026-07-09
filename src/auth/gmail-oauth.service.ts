import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import { randomUUID } from 'crypto';
import { basename, extname } from 'path';

@Injectable()
export class GmailOAuthService {
  constructor(private readonly configService: ConfigService) {}

  createAuthUrl() {
    const oauth2Client = this.createOAuthClient();
    const state = randomUUID();
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.readonly',
      ],
      state,
    });

    return { state, url };
  }

  createDriveAuthUrl() {
    const oauth2Client = this.createDriveOAuthClient();
    const state = randomUUID();
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/spreadsheets',
      ],
      state,
    });
    return { state, url };
  }

  async exchangeCode(code: string) {
    const oauth2Client = this.createOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    return {
      access_token: tokens.access_token ?? '',
      refresh_token: tokens.refresh_token ?? '',
      expiry_date: tokens.expiry_date ?? null,
      scope: tokens.scope ?? '',
      token_type: tokens.token_type ?? '',
      advice:
        tokens.refresh_token && tokens.refresh_token.length
          ? 'Guarda refresh_token en GOOGLE_GMAIL_OAUTH_REFRESH_TOKEN'
          : 'No llego refresh_token. Repite consentimiento con prompt=consent y access_type=offline',
    };
  }

  async exchangeDriveCode(code: string) {
    const oauth2Client = this.createDriveOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    return {
      access_token: tokens.access_token ?? '',
      refresh_token: tokens.refresh_token ?? '',
      expiry_date: tokens.expiry_date ?? null,
      scope: tokens.scope ?? '',
      token_type: tokens.token_type ?? '',
      advice:
        tokens.refresh_token && tokens.refresh_token.length
          ? 'Guarda refresh_token en GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN'
          : 'No llego refresh_token. Repite consentimiento con prompt=consent y access_type=offline',
    };
  }

  async sendMail(params: { to: string; subject: string; message: string }) {
    const gmail = this.createGmailClient();
    const userId = this.configService.get<string>('GOOGLE_GMAIL_USER_ID', 'me');

    const mime = [
      `To: ${params.to}`,
      `Subject: ${params.subject}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      params.message,
    ].join('\r\n');

    const raw = Buffer.from(mime)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const sent = await gmail.users.messages.send({
      userId,
      requestBody: { raw },
    });

    return {
      to: params.to,
      subject: params.subject,
      messageId: sent.data.id ?? '',
      threadId: sent.data.threadId ?? '',
    };
  }

  async getThread(threadId: string) {
    const gmail = this.createGmailClient();
    const userId = this.configService.get<string>('GOOGLE_GMAIL_USER_ID', 'me');
    const thread = await gmail.users.threads.get({
      userId,
      id: threadId,
      format: 'full',
    });

    const messages = (thread.data.messages ?? []).map((message) => ({
      id: message.id ?? '',
      threadId: message.threadId ?? '',
      internalDate: message.internalDate ?? '',
      subject: this.getHeader(message.payload?.headers, 'Subject'),
      from: this.getHeader(message.payload?.headers, 'From'),
      to: this.getHeader(message.payload?.headers, 'To'),
      snippet: message.snippet ?? '',
      textBody: this.extractBodyText(message.payload),
    }));

    return {
      threadId,
      messageCount: messages.length,
      messages,
    };
  }

  async getReplies(threadId: string) {
    const thread = await this.getThread(threadId);
    const replies = thread.messages.slice(1);
    return {
      threadId,
      replyCount: replies.length,
      replies,
    };
  }

  async detectInboxReplies(maxResults = 25, targetThreadId?: string) {
    const gmail = this.createGmailClient();
    const userId = this.configService.get<string>('GOOGLE_GMAIL_USER_ID', 'me');
    const mailboxEmail = await this.getMailboxEmail();

    const listed = await gmail.users.messages.list({
      userId,
      maxResults,
      q: 'in:inbox newer_than:15d',
    });

    const messages = listed.data.messages ?? [];
    const analyzed: Array<{
      messageId: string;
      threadId: string;
      from: string;
      fromEmail: string;
      subject: string;
      date: string;
      snippet: string;
      valid: boolean;
      reason: string;
      linkedToOutgoingThread: boolean;
    }> = [];

    for (const item of messages) {
      if (!item.id) continue;

      const msg = await gmail.users.messages.get({
        userId,
        id: item.id,
        format: 'full',
      });

      const headers = msg.data.payload?.headers ?? [];
      const from = this.getHeader(headers, 'From');
      const subject = this.getHeader(headers, 'Subject');
      const date = this.getHeader(headers, 'Date');
      const autoSubmitted = this.getHeader(headers, 'Auto-Submitted');
      const precedence = this.getHeader(headers, 'Precedence').toLowerCase();
      const threadId = msg.data.threadId ?? '';
      if (targetThreadId && threadId !== targetThreadId) {
        continue;
      }
      const fromEmail = this.extractEmail(from).toLowerCase();
      const isFromSelf = fromEmail === mailboxEmail.toLowerCase();
      const isAuto =
        !!autoSubmitted &&
        autoSubmitted.toLowerCase() !== 'no' &&
        autoSubmitted.toLowerCase() !== '';
      const isBulk =
        precedence === 'bulk' || precedence === 'list' || precedence === 'junk';
      const hasContent = !!(subject?.trim() || msg.data.snippet?.trim());

      let linkedToOutgoingThread = false;
      if (threadId) {
        linkedToOutgoingThread = await this.threadHasOutgoingMessage(
          threadId,
          mailboxEmail,
        );
      }

      let valid = true;
      let reason = 'valid_reply';

      if (!threadId) {
        valid = false;
        reason = 'missing_thread';
      } else if (isFromSelf) {
        valid = false;
        reason = 'sent_by_self';
      } else if (isAuto) {
        valid = false;
        reason = 'auto_submitted';
      } else if (isBulk) {
        valid = false;
        reason = 'bulk_or_list_message';
      } else if (!hasContent) {
        valid = false;
        reason = 'empty_content';
      } else if (!linkedToOutgoingThread) {
        valid = false;
        reason = 'thread_without_outgoing_origin';
      }

      analyzed.push({
        messageId: msg.data.id ?? '',
        threadId,
        from,
        fromEmail,
        subject,
        date,
        snippet: msg.data.snippet ?? '',
        valid,
        reason,
        linkedToOutgoingThread,
      });
    }

    const validReplies = analyzed.filter((m) => m.valid);

    return {
      mailboxEmail,
      targetThreadId: targetThreadId ?? '',
      scanned: analyzed.length,
      validRepliesCount: validReplies.length,
      validReplies,
      invalidReplies: analyzed.filter((m) => !m.valid),
    };
  }

  async getMessageContext(messageId: string): Promise<{
    messageId: string;
    threadId: string;
    subject: string;
    from: string;
    to: string;
    textBody: string;
    snippet: string;
  }> {
    const gmail = this.createGmailClient();
    const userId = this.configService.get<string>('GOOGLE_GMAIL_USER_ID', 'me');
    const msg = await gmail.users.messages.get({
      userId,
      id: messageId,
      format: 'full',
    });
    const headers = msg.data.payload?.headers ?? [];
    return {
      messageId: msg.data.id ?? messageId,
      threadId: msg.data.threadId ?? '',
      subject: this.getHeader(headers, 'Subject'),
      from: this.getHeader(headers, 'From'),
      to: this.getHeader(headers, 'To'),
      textBody: this.extractBodyText(msg.data.payload),
      snippet: msg.data.snippet ?? '',
    };
  }

  async downloadMessageAsEml(messageId: string): Promise<Buffer> {
    const gmail = this.createGmailClient();
    const userId = this.configService.get<string>('GOOGLE_GMAIL_USER_ID', 'me');
    const msg = await gmail.users.messages.get({
      userId,
      id: messageId,
      format: 'raw',
    });
    const raw = msg.data.raw ?? '';
    if (!raw) {
      return Buffer.alloc(0);
    }
    return Buffer.from(this.normalizeBase64Url(raw), 'base64');
  }

  async getMessageAttachments(messageId: string): Promise<
    Array<{
      filename: string;
      mimeType: string;
      extension: string;
      buffer: Buffer;
    }>
  > {
    const gmail = this.createGmailClient();
    const userId = this.configService.get<string>('GOOGLE_GMAIL_USER_ID', 'me');
    const msg = await gmail.users.messages.get({
      userId,
      id: messageId,
      format: 'full',
    });

    const parts = this.collectAttachmentParts(msg.data.payload);
    const attachments: Array<{
      filename: string;
      mimeType: string;
      extension: string;
      buffer: Buffer;
    }> = [];

    for (const part of parts) {
      const attachmentId = part.body?.attachmentId;
      if (!attachmentId) {
        continue;
      }

      const fetched = await gmail.users.messages.attachments.get({
        userId,
        messageId,
        id: attachmentId,
      });

      const data = fetched.data.data ?? '';
      if (!data) continue;
      const filename = basename(part.filename || 'archivo_adjunto');
      const extension = extname(filename).toLowerCase();
      attachments.push({
        filename,
        mimeType: part.mimeType || 'application/octet-stream',
        extension,
        buffer: Buffer.from(this.normalizeBase64Url(data), 'base64'),
      });
    }

    return attachments;
  }

  async sendMailWithAttachments(params: {
    to: string;
    subject: string;
    message: string;
    attachments: Array<{ filename: string; mimeType: string; buffer: Buffer }>;
  }): Promise<{ messageId: string; threadId: string; emlBuffer: Buffer }> {
    const gmail = this.createGmailClient();
    const userId = this.configService.get<string>('GOOGLE_GMAIL_USER_ID', 'me');
    const mime = this.buildMimeWithAttachments(params);
    const raw = Buffer.from(mime)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const sent = await gmail.users.messages.send({
      userId,
      requestBody: { raw },
    });

    return {
      messageId: sent.data.id ?? '',
      threadId: sent.data.threadId ?? '',
      emlBuffer: Buffer.from(mime, 'utf8'),
    };
  }

  async markMessageAsRead(messageId: string): Promise<void> {
    const gmail = this.createGmailClient();
    const userId = this.configService.get<string>('GOOGLE_GMAIL_USER_ID', 'me');
    await gmail.users.messages.modify({
      userId,
      id: messageId,
      requestBody: {
        removeLabelIds: ['UNREAD'],
      },
    });
  }

  private createOAuthClient() {
    const clientId = this.configService.getOrThrow<string>(
      'GOOGLE_GMAIL_OAUTH_CLIENT_ID',
    );
    const clientSecret = this.configService.getOrThrow<string>(
      'GOOGLE_GMAIL_OAUTH_CLIENT_SECRET',
    );
    const redirectUri = this.configService.getOrThrow<string>(
      'GOOGLE_GMAIL_OAUTH_REDIRECT_URI',
    );

    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  private createDriveOAuthClient() {
    const clientId = this.configService.getOrThrow<string>(
      'GOOGLE_DRIVE_OAUTH_CLIENT_ID',
    );
    const clientSecret = this.configService.getOrThrow<string>(
      'GOOGLE_DRIVE_OAUTH_CLIENT_SECRET',
    );
    const redirectUri = this.configService.getOrThrow<string>(
      'GOOGLE_DRIVE_OAUTH_REDIRECT_URI',
    );
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  private createGmailClient() {
    const oauth2Client = this.createOAuthClient();
    oauth2Client.setCredentials({
      refresh_token: this.configService.getOrThrow<string>(
        'GOOGLE_GMAIL_OAUTH_REFRESH_TOKEN',
      ),
    });
    return google.gmail({ version: 'v1', auth: oauth2Client });
  }

  private async getMailboxEmail(): Promise<string> {
    const gmail = this.createGmailClient();
    const userId = this.configService.get<string>('GOOGLE_GMAIL_USER_ID', 'me');
    const profile = await gmail.users.getProfile({ userId });
    return profile.data.emailAddress ?? '';
  }

  private async threadHasOutgoingMessage(
    threadId: string,
    mailboxEmail: string,
  ): Promise<boolean> {
    const gmail = this.createGmailClient();
    const userId = this.configService.get<string>('GOOGLE_GMAIL_USER_ID', 'me');
    const normalizedMailbox = mailboxEmail.toLowerCase();

    const thread = await gmail.users.threads.get({
      userId,
      id: threadId,
      format: 'metadata',
      metadataHeaders: ['From'],
    });

    const messages = thread.data.messages ?? [];
    return messages.some((message) => {
      const from = this.getHeader(message.payload?.headers, 'From');
      const fromEmail = this.extractEmail(from).toLowerCase();
      return fromEmail === normalizedMailbox;
    });
  }

  private getHeader(
    headers: Array<{ name?: string | null; value?: string | null }> | undefined,
    headerName: string,
  ) {
    if (!headers?.length) {
      return '';
    }
    const item = headers.find(
      (h) => (h.name || '').toLowerCase() === headerName.toLowerCase(),
    );
    return item?.value ?? '';
  }

  private extractBodyText(
    payload:
      | {
          mimeType?: string | null;
          body?: { data?: string | null } | null;
          parts?: any[] | null;
        }
      | undefined,
  ): string {
    if (!payload) {
      return '';
    }

    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return this.decodeBase64Url(payload.body.data);
    }

    if (payload.parts?.length) {
      for (const part of payload.parts) {
        const txt = this.extractBodyText(part);
        if (txt) {
          return txt;
        }
      }
    }

    return '';
  }

  private decodeBase64Url(input: string): string {
    const padded = this.normalizeBase64Url(input);
    return Buffer.from(padded, 'base64').toString('utf8');
  }

  private normalizeBase64Url(input: string): string {
    const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = normalized.length % 4;
    return pad ? normalized + '='.repeat(4 - pad) : normalized;
  }

  private extractEmail(value: string): string {
    if (!value) {
      return '';
    }
    const match = value.match(/<([^>]+)>/);
    return (match?.[1] ?? value).trim();
  }

  private collectAttachmentParts(
    payload:
      | {
          mimeType?: string | null;
          filename?: string | null;
          body?: { attachmentId?: string | null } | null;
          parts?: any[] | null;
        }
      | undefined,
  ): Array<{
    mimeType: string;
    filename: string;
    body?: { attachmentId?: string | null } | null;
  }> {
    if (!payload) {
      return [];
    }

    const current: Array<{
      mimeType: string;
      filename: string;
      body?: { attachmentId?: string | null } | null;
    }> = [];

    if (payload.filename && payload.body?.attachmentId) {
      current.push({
        mimeType: payload.mimeType ?? 'application/octet-stream',
        filename: payload.filename,
        body: payload.body,
      });
    }

    const nested = (payload.parts ?? []).flatMap((part) =>
      this.collectAttachmentParts(part),
    );
    return [...current, ...nested];
  }

  private buildMimeWithAttachments(params: {
    to: string;
    subject: string;
    message: string;
    attachments: Array<{ filename: string; mimeType: string; buffer: Buffer }>;
  }): string {
    const boundary = `boundary_${Date.now()}`;
    const encodedSubject = this.encodeMimeHeader(params.subject || '');
    const textBase64 = Buffer.from(params.message || '', 'utf8').toString('base64');
    const chunks = [
      `To: ${params.to}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      textBase64,
      '',
    ];

    for (const attachment of params.attachments ?? []) {
      const safeName = basename(attachment.filename || 'adjunto.bin');
      const mimeType = attachment.mimeType || 'application/octet-stream';
      chunks.push(
        `--${boundary}`,
        `Content-Type: ${mimeType}; name="${safeName}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${safeName}"`,
        '',
        attachment.buffer.toString('base64'),
        '',
      );
    }

    chunks.push(`--${boundary}--`);
    return chunks.join('\r\n');
  }

  private encodeMimeHeader(value: string): string {
    const raw = String(value ?? '').trim();
    if (!raw) {
      return '';
    }
    const base64 = Buffer.from(raw, 'utf8').toString('base64');
    return `=?UTF-8?B?${base64}?=`;
  }
}
