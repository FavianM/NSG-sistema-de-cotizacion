'use strict';

const express = require('express');
const router = express.Router();
const { verificarTokenAdmin } = require('../middleware/auth');
const {
  listarCuentas,
  crearCuenta,
  actualizarCuenta,
  eliminarCuenta,
} = require('../controladores/controladorCuentas');

// Gestión de cuentas: SOLO administrador (control total del sistema).
router.get('/', verificarTokenAdmin, listarCuentas);
router.post('/', verificarTokenAdmin, crearCuenta);
router.put('/:id', verificarTokenAdmin, actualizarCuenta);
router.delete('/:id', verificarTokenAdmin, eliminarCuenta);

module.exports = router;
