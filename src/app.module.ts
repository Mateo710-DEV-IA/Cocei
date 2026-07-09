import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ContractsModule } from './contracts/contracts.module';
import { AuthModule } from './auth/auth.module';
import { SystemErrorFilter } from './common/system-error.filter';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ContractsModule,
    AuthModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: SystemErrorFilter,
    },
  ],
})
export class AppModule {}
