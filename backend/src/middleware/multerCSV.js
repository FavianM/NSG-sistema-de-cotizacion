'use strict';

/**
 * Middleware Multer — CSV de importación
 *
 * Almacena el CSV en memoria (buffer) para procesamiento inmediato.
 * Acepta solo archivos .csv con MIME text/csv, text/plain o derivados.
 * Máximo 50 MB.
 *
 * Requisito: 5.10
 */

const multer = require('multer');
const path = require('path');

const filtroCSV = (_req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const tiposPermitidos = ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'];

  if (ext === '.csv' && (tiposPermitidos.includes(file.mimetype) || file.mimetype.includes('csv'))) {
    cb(null, true);
  } else {
    const error = new Error('Solo se aceptan archivos .csv');
    error.codigo = 'TIPO_INVALIDO';
    cb(error);
  }
};

const uploadCSV = multer({
  storage: multer.memoryStorage(), // CSV en memoria para procesamiento inmediato
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: filtroCSV,
});

module.exports = uploadCSV;
