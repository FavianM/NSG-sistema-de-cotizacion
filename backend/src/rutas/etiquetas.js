'use strict';

const express = require('express');
const router = express.Router();
const { listarEtiquetas } = require('../controladores/controladorEtiquetas');

// GET /api/etiquetas — lista pública de etiquetas de perfil (para filtros/selectores).
router.get('/', listarEtiquetas);

module.exports = router;
