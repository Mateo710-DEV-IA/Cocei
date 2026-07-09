export interface ContractData {
  contrato: {
    id_contrato: number;
    folio_digital: string;
    fecha_ini: string;
    iddrive: string;
    is_cancelado: number;
    detalle_servicio: string;
    nom_servicio: string;
    email_integradora: string;
    email_ejecutora: string;
    rfc_ejecutora: string;
  };
  solicitante: {
    razon_social: string;
    rfc: string;
    direccion: string;
    email: string;
  };
  integradora: {
    razon_social: string;
    rfc: string;
    direccion: string;
    email: string;
  };
  ejecutora: {
    razon_social: string;
    rfc: string;
    direccion: string;
    email: string;
  };
}

export interface ProcessResult {
  folio_digital: string;
  id_contrato: number;
  driveFolderId: string;
  ot: ProcessDocumentResult;
  os: ProcessDocumentResult;
}

export interface ProcessCancelledResult {
  folio_digital: string;
  id_contrato: number;
  cancelled: true;
  message: string;
}

export interface ProcessDocumentResult {
  pdfFileId: string;
  pdfName: string;
  webViewLink: string;
  mailTo: string;
  mailMessageId: string;
  emlFileId: string;
  emlName: string;
  emlWebViewLink: string;
}
