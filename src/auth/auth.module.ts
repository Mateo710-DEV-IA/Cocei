import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { GmailOAuthService } from './gmail-oauth.service';
import { GmailDetectorService } from './gmail-detector.service';
import { ContractsModule } from '../contracts/contracts.module';

@Module({
  imports: [ContractsModule],
  controllers: [AuthController],
  providers: [GmailOAuthService, GmailDetectorService],
})
export class AuthModule {}
