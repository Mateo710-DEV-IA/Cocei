import { Module } from '@nestjs/common';
import { ContractsController } from './contracts.controller';
import { GoogleWorkspaceService } from './services/google-workspace.service';
import { ContractProcessService } from './services/contract-process.service';
import { SqlService } from './services/sql.service';
import { DeepseekMailComposerService } from './services/deepseek-mail-composer.service';
import { DeliverableClassifierService } from './services/deliverable-classifier.service';
import { SystemErrorService } from '../common/system-error.service';

@Module({
  controllers: [ContractsController],
  providers: [
    GoogleWorkspaceService,
    ContractProcessService,
    SqlService,
    DeepseekMailComposerService,
    DeliverableClassifierService,
    SystemErrorService,
  ],
  exports: [
    GoogleWorkspaceService,
    SqlService,
    DeliverableClassifierService,
    SystemErrorService,
  ],
})
export class ContractsModule {}
