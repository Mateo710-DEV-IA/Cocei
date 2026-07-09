/* eslint-disable no-console */
const { spawnSync } = require('child_process');

function randomDigits(length) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += Math.floor(Math.random() * 10).toString();
  }
  return out;
}

function generateFolioDigital() {
  const year = new Date().getFullYear().toString().slice(-2);
  const solicitante = randomDigits(3);
  const integradora = randomDigits(3);
  const servicio = randomDigits(6);
  const consecutivo = randomDigits(5);
  return `${year}-${solicitante}-${integradora}-${servicio}-${consecutivo}`;
}

function isValidFolioDigital(value) {
  return /^\d{2}-[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{5,6}-\d{5}$/.test(value);
}

async function callCancelEndpoint(params) {
  const response = await fetch(params.cancelEndpointUrl, {
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
  const uploadEndpointUrl =
    process.argv[2] || 'http://localhost:3000/contracts/upload-pdf';
  const folioArg = process.argv[3];
  const processEndpointUrl =
    process.argv[4] || uploadEndpointUrl.replace('/upload-pdf', '/process');
  const sourcePdfPathArg = process.argv[5];
  const cancelEndpointUrl =
    process.argv[6] || uploadEndpointUrl.replace('/upload-pdf', '/cancel');

  const folioDigital = folioArg || generateFolioDigital();
  if (!isValidFolioDigital(folioDigital)) {
    console.error(`Folio invalido: ${folioDigital}`);
    console.error('Usa formato: AA-EEE-III-TTTTT-00000 o AA-EEE-III-TTTTTT-00000');
    process.exit(1);
  }

  console.log('--- SIMULACION + CANCELACION COCEI ---');
  console.log(`Upload endpoint: ${uploadEndpointUrl}`);
  console.log(`Process endpoint: ${processEndpointUrl}`);
  console.log(`Cancel endpoint: ${cancelEndpointUrl}`);
  console.log(`Folio: ${folioDigital}`);

  const simulationArgs = [
    'scripts/send-simulated-contract.js',
    uploadEndpointUrl,
    folioDigital,
    processEndpointUrl,
  ];
  if (sourcePdfPathArg) {
    simulationArgs.push(sourcePdfPathArg);
  }

  console.log('');
  console.log('[1/2] Ejecutando simulacion base...');
  const simulation = spawnSync(process.execPath, simulationArgs, {
    stdio: 'inherit',
  });

  if (simulation.status !== 0) {
    console.error(
      `Simulacion fallo con codigo ${simulation.status}. No se ejecuta cancelacion.`,
    );
    process.exit(simulation.status || 1);
  }

  console.log('');
  console.log('[2/2] Ejecutando cancelacion...');
  const cancel = await callCancelEndpoint({ cancelEndpointUrl, folioDigital });
  console.log(`HTTP status cancel: ${cancel.status}`);
  console.log('Respuesta endpoint cancel:');
  console.log(JSON.stringify(cancel.payload, null, 2));

  if (!cancel.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Error en script de simulacion + cancelacion:', error.message);
  process.exit(1);
});
