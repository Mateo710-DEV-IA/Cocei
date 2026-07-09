import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mssql from 'mssql';
import { ContractData } from '../interfaces/contract-data.interface';

@Injectable()
export class SqlService {
  private pool: mssql.ConnectionPool | null = null;

  constructor(private readonly configService: ConfigService) {}

  private async getPool(): Promise<mssql.ConnectionPool> {
    if (this.pool?.connected) {
      return this.pool;
    }

    const config: mssql.config = {
      user: this.configService.getOrThrow<string>('DB_USER'),
      password: this.configService.getOrThrow<string>('DB_PASSWORD'),
      server: this.configService.getOrThrow<string>('DB_HOST'),
      database: this.configService.getOrThrow<string>('DB_NAME'),
      options: {
        encrypt: this.configService.get<string>('DB_ENCRYPT', 'true') === 'true',
        trustServerCertificate:
          this.configService.get<string>('DB_TRUST_CERT', 'false') === 'true',
      },
      port: Number(this.configService.get<string>('DB_PORT', '1433')),
    };

    this.pool = await new mssql.ConnectionPool(config).connect();
    return this.pool;
  }

  async getContractByFolio(folioDigital: string): Promise<ContractData> {
    try {
      const pool = await this.getPool();
      const result = await pool
        .request()
        .input('folio', mssql.VarChar(100), folioDigital)
        .query(`
          SELECT
              c.*,
              sol.razon_social_solicitante AS razon_social_solicitante,
              sol.rfc_solicitante AS rfc_solicitante,
              sol.direc_solicitante AS direc_solicitante,
              sol.email_solicitante AS email_solicitante,
              intg.razon_social_integradora AS razon_social_integradora,
              intg.rfc_integradora AS rfc_integradora,
              intg.direc_integradora AS direc_integradora,
              intg.email_integradora AS email_integradora,
              eje.razon_social_ejecutora AS razon_social_ejecutora,
              eje.rfc_ejecutora AS rfc_ejecutora,
              eje.direc_ejecutora AS direc_ejecutora,
              eje.email_ejecutora AS email_ejecutora,
              srv.nom_servicio
          FROM tab_contratos c
          LEFT JOIN tab_empresas_solicitantes sol ON c.id_solicitante = sol.id_solicitante
          LEFT JOIN tab_empresas_integradoras intg ON c.id_integradora = intg.id_integradora
          LEFT JOIN tab_empresas_ejecutoras eje ON c.id_ejecutora = eje.id_ejecutora
          LEFT JOIN tab_servicios srv ON c.id_servicio = srv.id_servicio
          WHERE c.folio_digital = @folio
        `);

      if (!result.recordset.length) {
        throw new NotFoundException(
          `No existe contrato para folio_digital: ${folioDigital}`,
        );
      }

      const raw = result.recordset[0];
      return {
        contrato: {
          id_contrato: raw.id_contrato,
          folio_digital: raw.folio_digital,
          fecha_ini: raw.fecha_ini,
          iddrive: raw.iddrive,
          is_cancelado: Number(raw.isCancelado ?? 0),
          detalle_servicio: raw.detalle_servicio,
          nom_servicio: raw.nom_servicio,
          email_integradora: raw.email_integradora,
          email_ejecutora: raw.email_ejecutora,
          rfc_ejecutora: raw.rfc_ejecutora,
        },
        solicitante: {
          razon_social: raw.razon_social_solicitante,
          rfc: raw.rfc_solicitante,
          direccion: raw.direc_solicitante,
          email: raw.email_solicitante,
        },
        integradora: {
          razon_social: raw.razon_social_integradora,
          rfc: raw.rfc_integradora,
          direccion: raw.direc_integradora,
          email: raw.email_integradora,
        },
        ejecutora: {
          razon_social: raw.razon_social_ejecutora,
          rfc: raw.rfc_ejecutora,
          direccion: raw.direc_ejecutora,
          email: raw.email_ejecutora,
        },
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new InternalServerErrorException(
        `Error consultando SQL Server: ${(error as Error).message}`,
      );
    }
  }

  async getContractTrackStatus(folioDigital: string): Promise<{
    idContrato: number;
    isCancelado: boolean;
    latestEtapa: number | null;
    maxEtapa: number | null;
    hasEtapa15: boolean;
    hasEtapa16: boolean;
    paymentTrackLatest: number | null;
    paymentTrackComplete: boolean;
    deliverablesComplete: boolean;
    readyForEntregables: boolean;
    hasFacturaEjecutoraReceived: boolean;
  }> {
    const gate = await this.getContractStageStatusByFolio(folioDigital);
    const pool = await this.getPool();
    const trackResult = await pool
      .request()
      .input('idContrato', mssql.Int, gate.idContrato)
      .query(`
        SELECT
          (
            SELECT TOP 1 id_etapa
            FROM tab_contratos_detalle
            WHERE id_contrato = @idContrato
              AND id_etapa IN (4, 5, 6, 7, 8, 9, 10, 11)
            ORDER BY fecha_det DESC, id_etapa DESC
          ) AS payment_track_latest,
          (
            SELECT COUNT(1)
            FROM tab_contratos_detalle
            WHERE id_contrato = @idContrato AND id_etapa = 11
          ) AS has_etapa_11,
          (
            SELECT COUNT(1)
            FROM tab_contratos_detalle
            WHERE id_contrato = @idContrato AND id_etapa = 14
          ) AS has_etapa_14,
          (
            SELECT COUNT(1)
            FROM tab_contratos_detalle
            WHERE id_contrato = @idContrato AND id_etapa = 4
          ) AS has_etapa_4
      `);

    const row = trackResult.recordset[0] ?? {};
    return {
      ...gate,
      paymentTrackLatest:
        row.payment_track_latest === null || row.payment_track_latest === undefined
          ? null
          : Number(row.payment_track_latest),
      paymentTrackComplete: Number(row.has_etapa_11 ?? 0) > 0,
      deliverablesComplete: Number(row.has_etapa_14 ?? 0) > 0,
      // Entregables se habilitan apenas existe factura de ejecutora (etapa 4),
      // sin esperar a que la factura llegue a solicitante (etapa 7).
      readyForEntregables: Number(row.has_etapa_4 ?? 0) > 0,
      hasFacturaEjecutoraReceived: Number(row.has_etapa_4 ?? 0) > 0,
    };
  }

  async getContractStageStatusByFolio(folioDigital: string): Promise<{
    idContrato: number;
    isCancelado: boolean;
    latestEtapa: number | null;
    maxEtapa: number | null;
    hasEtapa15: boolean;
    hasEtapa16: boolean;
  }> {
    try {
      const pool = await this.getPool();
      const contractResult = await pool
        .request()
        .input('folio', mssql.VarChar(100), folioDigital)
        .query(`
          SELECT TOP 1
            id_contrato,
            ISNULL(isCancelado, 0) AS isCancelado
          FROM tab_contratos
          WHERE folio_digital = @folio
        `);

      if (!contractResult.recordset.length) {
        throw new NotFoundException(
          `No existe contrato para folio_digital: ${folioDigital}`,
        );
      }

      const idContrato = Number(contractResult.recordset[0].id_contrato);
      const isCancelado = Number(contractResult.recordset[0].isCancelado) === 1;

      const detailResult = await pool
        .request()
        .input('idContrato', mssql.Int, idContrato)
        .query(`
          SELECT
            (
              SELECT TOP 1 id_etapa
              FROM tab_contratos_detalle
              WHERE id_contrato = @idContrato
              ORDER BY fecha_det DESC, id_etapa DESC
            ) AS latest_etapa,
            (
              SELECT MAX(id_etapa)
              FROM tab_contratos_detalle
              WHERE id_contrato = @idContrato
            ) AS max_etapa,
            (
              SELECT COUNT(1)
              FROM tab_contratos_detalle
              WHERE id_contrato = @idContrato AND id_etapa = 15
            ) AS has_etapa_15,
            (
              SELECT COUNT(1)
              FROM tab_contratos_detalle
              WHERE id_contrato = @idContrato AND id_etapa = 16
            ) AS has_etapa_16
        `);

      const row = detailResult.recordset[0] ?? {};
      return {
        idContrato,
        isCancelado,
        latestEtapa:
          row.latest_etapa === null || row.latest_etapa === undefined
            ? null
            : Number(row.latest_etapa),
        maxEtapa:
          row.max_etapa === null || row.max_etapa === undefined
            ? null
            : Number(row.max_etapa),
        hasEtapa15: Number(row.has_etapa_15 ?? 0) > 0,
        hasEtapa16: Number(row.has_etapa_16 ?? 0) > 0,
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new InternalServerErrorException(
        `Error consultando estado de etapas en SQL Server: ${(error as Error).message}`,
      );
    }
  }

  async insertContractDetail(params: {
    idContrato: number;
    idEtapa: number;
    nomDocumento: string;
    urlDocumento: string;
  }): Promise<void> {
    try {
      const pool = await this.getPool();
      await pool
        .request()
        .input('idContrato', mssql.Int, params.idContrato)
        .input('idEtapa', mssql.Int, params.idEtapa)
        .input('nomDocumento', mssql.VarChar(255), params.nomDocumento)
        .input('urlDocumento', mssql.VarChar(500), params.urlDocumento).query(`
          INSERT INTO tab_contratos_detalle
            (id_contrato, fecha_det, id_etapa, nom_documento, url_documento, motivo_cancelacion, id_sinc, fecha_sinc)
          VALUES
            (@idContrato, GETDATE(), @idEtapa, @nomDocumento, @urlDocumento, '', 1, GETDATE())
        `);
    } catch (error) {
      throw new InternalServerErrorException(
        `Error insertando detalle en SQL Server: ${(error as Error).message}`,
      );
    }
  }

  async hasContractDetailByDocumentName(params: {
    idContrato: number;
    idEtapa: number;
    documentName: string;
  }): Promise<boolean> {
    try {
      const pool = await this.getPool();
      const result = await pool
        .request()
        .input('idContrato', mssql.Int, params.idContrato)
        .input('idEtapa', mssql.Int, params.idEtapa)
        .input('documentName', mssql.VarChar(255), params.documentName).query(`
          SELECT TOP 1 1 AS exists_row
          FROM tab_contratos_detalle
          WHERE id_contrato = @idContrato
            AND id_etapa = @idEtapa
            AND nom_documento LIKE '%' + @documentName + '%'
        `);
      return !!result.recordset.length;
    } catch (error) {
      throw new InternalServerErrorException(
        `Error validando detalle existente en SQL Server: ${(error as Error).message}`,
      );
    }
  }

  async hasContractDetailByStage(params: {
    idContrato: number;
    idEtapa: number;
  }): Promise<boolean> {
    try {
      const pool = await this.getPool();
      const result = await pool
        .request()
        .input('idContrato', mssql.Int, params.idContrato)
        .input('idEtapa', mssql.Int, params.idEtapa).query(`
          SELECT TOP 1 1 AS exists_row
          FROM tab_contratos_detalle
          WHERE id_contrato = @idContrato
            AND id_etapa = @idEtapa
        `);
      return !!result.recordset.length;
    } catch (error) {
      throw new InternalServerErrorException(
        `Error validando etapa existente en SQL Server: ${(error as Error).message}`,
      );
    }
  }

  async setContractCancelStatus(params: {
    idContrato: number;
    isCancelado: boolean;
  }): Promise<void> {
    try {
      const pool = await this.getPool();
      await pool
        .request()
        .input('idContrato', mssql.Int, params.idContrato)
        .input('isCancelado', mssql.Int, params.isCancelado ? 1 : 0).query(`
          UPDATE tab_contratos
          SET isCancelado = @isCancelado,
              id_sinc = 1,
              fecha_sinc = GETDATE()
          WHERE id_contrato = @idContrato
        `);
    } catch (error) {
      throw new InternalServerErrorException(
        `Error actualizando estado de cancelacion en SQL Server: ${(error as Error).message}`,
      );
    }
  }

  async acquireFlowLock(lockKey: string, timeoutMs = 0): Promise<boolean> {
    try {
      const pool = await this.getPool();
      const result = await pool
        .request()
        .input('lockKey', mssql.VarChar(255), lockKey)
        .input('timeoutMs', mssql.Int, timeoutMs).query(`
          DECLARE @lockResult INT;
          EXEC @lockResult = sp_getapplock
            @Resource = @lockKey,
            @LockMode = 'Exclusive',
            @LockOwner = 'Session',
            @LockTimeout = @timeoutMs;
          SELECT @lockResult AS lock_result;
        `);

      const lockResult = Number(result.recordset[0]?.lock_result ?? -999);
      return lockResult >= 0;
    } catch (error) {
      throw new InternalServerErrorException(
        `Error adquiriendo lock de flujo en SQL Server: ${(error as Error).message}`,
      );
    }
  }

  async releaseFlowLock(lockKey: string): Promise<void> {
    try {
      const pool = await this.getPool();
      await pool.request().input('lockKey', mssql.VarChar(255), lockKey).query(`
          EXEC sp_releaseapplock
            @Resource = @lockKey,
            @LockOwner = 'Session';
        `);
    } catch (error) {
      throw new InternalServerErrorException(
        `Error liberando lock de flujo en SQL Server: ${(error as Error).message}`,
      );
    }
  }

  async getContractDetailTimeline(idContrato: number): Promise<
    Array<{
      idEtapa: number;
      nomEtapa: string;
      fechaDet: Date | string | null;
      nomDocumento: string;
      urlDocumento: string;
    }>
  > {
    try {
      const pool = await this.getPool();
      const result = await pool
        .request()
        .input('idContrato', mssql.Int, idContrato).query(`
          SELECT
            d.id_etapa AS idEtapa,
            ISNULL(e.nom_etapa, CONCAT('Etapa ', d.id_etapa)) AS nomEtapa,
            d.fecha_det AS fechaDet,
            ISNULL(d.nom_documento, '') AS nomDocumento,
            ISNULL(d.url_documento, '') AS urlDocumento
          FROM tab_contratos_detalle d
          LEFT JOIN tab_etapas e ON e.id_etapa = d.id_etapa
          WHERE d.id_contrato = @idContrato
          ORDER BY d.fecha_det ASC, d.id_etapa ASC
        `);

      return result.recordset.map((row) => ({
        idEtapa: Number(row.idEtapa),
        nomEtapa: String(row.nomEtapa || ''),
        fechaDet: row.fechaDet ?? null,
        nomDocumento: String(row.nomDocumento || ''),
        urlDocumento: String(row.urlDocumento || ''),
      }));
    } catch (error) {
      throw new InternalServerErrorException(
        `Error consultando timeline de detalles en SQL Server: ${(error as Error).message}`,
      );
    }
  }

  async getPartyIdsByFolio(folioDigital: string): Promise<{
    idSolicitante: number;
    idIntegradora: number;
    idEjecutora: number;
  } | null> {
    try {
      const pool = await this.getPool();
      const result = await pool
        .request()
        .input('folio', mssql.VarChar(100), folioDigital).query(`
          SELECT TOP 1
            ISNULL(id_solicitante, 0) AS id_solicitante,
            ISNULL(id_integradora, 0) AS id_integradora,
            ISNULL(id_ejecutora, 0) AS id_ejecutora
          FROM tab_contratos
          WHERE folio_digital = @folio
        `);
      if (!result.recordset.length) {
        return null;
      }
      const row = result.recordset[0];
      return {
        idSolicitante: Number(row.id_solicitante ?? 0),
        idIntegradora: Number(row.id_integradora ?? 0),
        idEjecutora: Number(row.id_ejecutora ?? 0),
      };
    } catch {
      return null;
    }
  }

  async insertSystemError(params: {
    folioDigital: string;
    resumenError: string;
    idSolicitante?: number;
    idIntegradora?: number;
    idEjecutora?: number;
  }): Promise<number | null> {
    try {
      const pool = await this.getPool();
      const folio = String(params.folioDigital || 'SYSTEM').trim().slice(0, 100) || 'SYSTEM';
      const resumen = String(params.resumenError || 'Error sin detalle').slice(0, 8000);
      const result = await pool
        .request()
        .input('folio', mssql.VarChar(100), folio)
        .input('resumen', mssql.NVarChar(mssql.MAX), resumen)
        .input('idSolicitante', mssql.Int, Number(params.idSolicitante ?? 0))
        .input('idIntegradora', mssql.Int, Number(params.idIntegradora ?? 0))
        .input('idEjecutora', mssql.Int, Number(params.idEjecutora ?? 0)).query(`
          INSERT INTO tab_errores
            (folio_digital, Resumen_error, fecha_error, id_solicitante, id_integradora, id_ejecutora)
          OUTPUT INSERTED.id_error
          VALUES
            (@folio, @resumen, GETDATE(), @idSolicitante, @idIntegradora, @idEjecutora)
        `);
      const idError = Number(result.recordset[0]?.id_error ?? 0);
      return idError > 0 ? idError : null;
    } catch (error) {
      // No relanzar: el registro de errores no debe tumbar el flujo principal.
      return null;
    }
  }
}
