/* eslint-disable no-console */
const fs = require('fs');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const mssql = require('mssql');
require('dotenv').config();

const DEFAULT_SIMULATION_PDF_PATH =
  'C:/Users/USUARIO/Downloads/contrato_servicios.pdf';

function randomDigits(length) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += Math.floor(Math.random() * 10).toString();
  }
  return out;
}

function generateFolioDigital() {
  const year = new Date().getFullYear().toString().slice(-2); // AA
  const solicitante = randomDigits(3); // EEE
  const integradora = randomDigits(3); // III
  const servicio = randomDigits(6); // TTTTTT
  const consecutivo = randomDigits(5); // 00000
  return `${year}-${solicitante}-${integradora}-${servicio}-${consecutivo}`;
}

function isValidFolioDigital(value) {
  // Formato flexible para casos reales observados:
  // AA-EEE-III-TTTTT(o TTTTTT)-00000
  return /^\d{2}-[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{5,6}-\d{5}$/.test(value);
}

async function buildSimulatedContractPdf(folioDigital) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  page.drawText('CONTRATO SIMULADO', {
    x: 50,
    y: 790,
    size: 22,
    font: fontBold,
    color: rgb(0.1, 0.1, 0.1),
  });

  const lines = [
    `Folio digital: ${folioDigital}`,
    `Fecha de generacion: ${new Date().toISOString()}`,
    '',
    'Documento de prueba para automatizacion COCEI.',
    'Este archivo simula el contrato cargado por endpoint.',
    '',
    'Clausula 1. Las partes acuerdan la prestacion del servicio.',
    'Clausula 2. El periodo del contrato sera segun fecha establecida.',
    'Clausula 3. El pago se realizara conforme al acuerdo comercial.',
  ];

  let currentY = 750;
  for (const line of lines) {
    page.drawText(line, {
      x: 50,
      y: currentY,
      size: 12,
      font,
      color: rgb(0.2, 0.2, 0.2),
    });
    currentY -= 24;
  }

  return Buffer.from(await pdf.save());
}

async function sendToEndpoint(params) {
  const form = new FormData();
  form.append('folio_digital', params.folioDigital);
  form.append(
    'file',
    new Blob([params.pdfBuffer], { type: 'application/pdf' }),
    `${params.folioDigital}_Contrato.pdf`,
  );

  const response = await fetch(params.endpointUrl, {
    method: 'POST',
    body: form,
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    payload,
  };
}

async function updateDriveFolderInSql(params) {
  const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_HOST,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 1433),
    options: {
      encrypt: String(process.env.DB_ENCRYPT).toLowerCase() === 'true',
      trustServerCertificate: String(process.env.DB_TRUST_CERT).toLowerCase() === 'true',
    },
  };

  const pool = await new mssql.ConnectionPool(config).connect();
  try {
    await pool
      .request()
      .input('folio', mssql.VarChar(100), params.folioDigital)
      .input('iddrive', mssql.VarChar(200), params.folderId)
      .query(`
        UPDATE tab_contratos
        SET iddrive = @iddrive
        WHERE folio_digital = @folio
      `);
  } finally {
    await pool.close();
  }
}

async function callProcessEndpoint(params) {
  const response = await fetch(params.processEndpointUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ folio_digital: params.folioDigital }),
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    payload,
  };
}

async function main() {
  const endpointUrl =
    process.argv[2] || 'http://localhost:3000/contracts/upload-pdf';
  const folioArg = process.argv[3];
  const processEndpointUrl =
    process.argv[4] || endpointUrl.replace('/upload-pdf', '/process');
  const sourcePdfPathArg = process.argv[5];
  const folioDigital = folioArg || generateFolioDigital();

  if (!isValidFolioDigital(folioDigital)) {
    console.error(`Folio invalido: ${folioDigital}`);
    console.error('Usa formato: AA-EEE-III-TTTTT-00000 o AA-EEE-III-TTTTTT-00000');
    process.exit(1);
  }
  const sourcePdfPath =
    sourcePdfPathArg ||
    process.env.SIMULATION_SOURCE_PDF_PATH ||
    DEFAULT_SIMULATION_PDF_PATH;

  let pdfBuffer;
  if (sourcePdfPath && fs.existsSync(sourcePdfPath)) {
    pdfBuffer = fs.readFileSync(sourcePdfPath);
  } else {
    console.warn(
      `No se encontro PDF fuente en "${sourcePdfPath}". Se genera PDF simulado.`,
    );
    pdfBuffer = await buildSimulatedContractPdf(folioDigital);
  }

  console.log('--- SIMULACION CONTRATO COCEI ---');
  console.log(`Endpoint: ${endpointUrl}`);
  console.log(`Endpoint process: ${processEndpointUrl}`);
  console.log(`PDF fuente: ${sourcePdfPath}`);
  console.log(`Folio generado: ${folioDigital}`);
  console.log(`PDF bytes: ${pdfBuffer.length}`);

  const result = await sendToEndpoint({ endpointUrl, folioDigital, pdfBuffer });

  console.log(`HTTP status: ${result.status}`);
  console.log('Respuesta endpoint:');
  console.log(JSON.stringify(result.payload, null, 2));

  if (!result.ok) {
    process.exit(1);
  }

  const folderId = result.payload?.folderId;
  if (!folderId) {
    console.error('No se recibio folderId del endpoint upload-pdf.');
    process.exit(1);
  }

  await updateDriveFolderInSql({ folioDigital, folderId });
  console.log(`iddrive actualizado en SQL para ${folioDigital}: ${folderId}`);

  const processResult = await callProcessEndpoint({
    processEndpointUrl,
    folioDigital,
  });

  console.log(`HTTP status process: ${processResult.status}`);
  console.log('Respuesta endpoint process:');
  console.log(JSON.stringify(processResult.payload, null, 2));

  if (!processResult.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Error en script de simulacion:', error.message);
  process.exit(1);
});
