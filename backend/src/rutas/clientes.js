/**
 * rutas/clientes.js
 *
 * Rutas para gestión de clientes.
 */

const express = require('express');
const { verificarTokenAdminOVendedor } = require('../middleware/auth');
const { buscarCliente, obtenerEmails } = require('../controladores/controladorClientes');

const router = express.Router();

// SEGURIDAD: ambas rutas devuelven PII descifrada (correo, teléfono);
// solo accesibles para admin/vendedor (autocompletado en panel interno).

// GET /api/clientes/buscar?q={email|telefono}
router.get('/buscar', verificarTokenAdminOVendedor, buscarCliente);

// GET /api/clientes/emails
router.get('/emails', verificarTokenAdminOVendedor, obtenerEmails);

module.exports = router;
