const express = require('express');
const router = express.Router();
const { verificarToken, verificarTokenAdmin, verificarTokenAdminOVendedor, verificarTokenUsuario, detectarUsuario } = require('../middleware/auth');
const {
  crearCotizacion,
  consultarCotizacion,
  validarCotizacion,
  obtenerPdfCotizacion,
  obtenerPdfTecnico,
  notificarCotizacionLista,
  marcarComoReclamada,
  confirmarCotizacion,
  solicitarConfirmacion,
  consultarHistorialCliente,
  obtenerPropias,
  listarClientesRegistrados,
  exportarExcel
} = require('../controladores/controladorCotizaciones');

// Crear nueva cotizacion (requiere login: admin o usuario)
router.post('/', verificarTokenUsuario, crearCotizacion);

// Listar todos los clientes registrados (admin o vendedor)
router.get('/clientes', verificarTokenAdminOVendedor, listarClientesRegistrados);

// Cotizaciones propias del usuario autenticado (debe ir ANTES de rutas con parámetros)
// Requisito: 5.1
router.get('/propias', verificarTokenUsuario, obtenerPropias);

// Historial por cliente (debe ir antes de /:codigoTicket)
// SEGURIDAD: requiere login; el controlador valida que un usuario solo vea su propio historial
router.get('/cliente/:email', verificarTokenUsuario, consultarHistorialCliente);

// Consultar y validar cotizacion por codigo ticket
// SEGURIDAD: detectarUsuario identifica el rol; el controlador omite margen/costos para no privilegiados
router.get('/:codigoTicket', detectarUsuario, consultarCotizacion);
router.get('/:codigoTicket/validar', detectarUsuario, validarCotizacion);

// Descargas PDF (requiere login; el controlador valida propiedad para rol usuario)
router.get('/:codigoTicket/pdf', verificarTokenUsuario, obtenerPdfCotizacion);
router.get('/:codigoTicket/pdf-tecnico', verificarTokenUsuario, obtenerPdfTecnico);

// Exportar a Excel (requiere login: admin o usuario)
router.get('/:codigoTicket/excel', verificarTokenUsuario, exportarExcel);

// El cliente solicita confirmar su cotizacion (contacto a ventas por WhatsApp).
// No requiere rol privilegiado: identifica por codigo de ticket.
router.post('/:codigoTicket/solicitar-confirmacion', detectarUsuario, solicitarConfirmacion);

// Flujo operativo (admin o vendedor: el vendedor gestiona/completa ventas)
router.put('/:codigoTicket/confirmar', verificarTokenAdminOVendedor, confirmarCotizacion);
router.put('/:codigoTicket/reclamar', verificarTokenAdminOVendedor, marcarComoReclamada);
router.post('/:codigoTicket/notificar-listo', verificarTokenAdminOVendedor, notificarCotizacionLista);

module.exports = router;

