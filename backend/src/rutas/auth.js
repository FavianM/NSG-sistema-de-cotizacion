const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const servicioAuth = require('../servicios/servicioAuth');
const servicioDni = require('../servicios/servicioDni');
const { verificarToken, verificarTokenUsuario } = require('../middleware/auth');
const { middlewareTurnstile } = require('../utilidades/turnstile');

// Rate limiter para registro (5 intentos / 15 min)
const limitadorRegistro = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    exito: false,
    error: 'Demasiados intentos de registro. Intenta mas tarde.'
  }
});

// Rate limiter para recuperación (3 intentos / 15 min)
const limitadorRecuperacion = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: {
    exito: false,
    error: 'Demasiadas solicitudes de recuperacion. Intenta mas tarde.'
  }
});

// Rate limiter estricto para consulta de DNI (PRE-auth, expone PII de RENIEC).
// No usa Turnstile: sus tokens son de un solo uso y quemarían el del registro.
const limitadorConsultaDni = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: {
    exito: false,
    error: 'Demasiadas consultas de DNI. Intenta mas tarde.'
  }
});

/**
 * POST /api/auth/login
 * Autentica un usuario (admin o usuario registrado) y retorna token JWT
 */
router.post('/login', middlewareTurnstile, async (req, res) => {
  try {
    const { correo, password } = req.body;

    if (!correo || !password) {
      return res.status(400).json({
        exito: false,
        error: 'Correo y password son requeridos'
      });
    }

    const resultado = await servicioAuth.login(correo, password);

    if (!resultado.exito) {
      console.warn(`[LOGIN_FALLIDO] ip=${req.ip}`);
      return res.status(resultado.status || 401).json(resultado);
    }

    res.json(resultado);
  } catch (error) {
    console.error('Error en /login:', error);
    res.status(500).json({
      exito: false,
      error: 'Error interno del servidor'
    });
  }
});

/**
 * POST /api/auth/verificar
 * Verifica si un token JWT es válido. Retorna rol en el usuario.
 */
router.post('/verificar', verificarTokenUsuario, async (req, res) => {
  try {
    res.json({
      valido: true,
      usuario: req.usuario,
      rol: req.rol
    });
  } catch (error) {
    console.error('Error en /verificar:', error);
    res.status(500).json({
      valido: false,
      error: 'Error interno del servidor'
    });
  }
});

/**
 * POST /api/auth/registro
 * Registra un nuevo usuario con rol 'usuario'.
 */
router.post('/registro', limitadorRegistro, middlewareTurnstile, async (req, res) => {
  try {
    const { password, confirmarPassword, correo, nombre, apellidos, telefono, dni } = req.body;

    if (!password || !confirmarPassword || !correo || !nombre || !apellidos || !telefono || !dni) {
      return res.status(400).json({
        exito: false,
        error: 'Todos los campos requeridos deben ser proporcionados',
        detalles: [
          { campo: 'password', mensaje: !password ? 'Contrasena es requerida' : null },
          { campo: 'confirmarPassword', mensaje: !confirmarPassword ? 'Confirmar contrasena es requerido' : null },
          { campo: 'correo', mensaje: !correo ? 'Correo electronico es requerido' : null },
          { campo: 'nombre', mensaje: !nombre ? 'Nombre es requerido' : null },
          { campo: 'apellidos', mensaje: !apellidos ? 'Apellidos son requeridos' : null },
          { campo: 'telefono', mensaje: !telefono ? 'Telefono es requerido' : null },
          { campo: 'dni', mensaje: !dni ? 'DNI es requerido' : null }
        ].filter(d => d.mensaje)
      });
    }

    const resultado = await servicioAuth.registrar({
      password,
      confirmarPassword,
      correo: correo.trim().toLowerCase(),
      nombre: nombre.trim(),
      apellidos: apellidos.trim(),
      telefono: telefono ? String(telefono).trim() : null,
      dni: dni ? String(dni).trim() : null
    });

    if (!resultado.exito) {
      return res.status(resultado.status || 400).json(resultado);
    }

    res.status(201).json(resultado);
  } catch (error) {
    console.error('Error en /registro:', error);
    res.status(500).json({
      exito: false,
      error: 'Error interno del servidor'
    });
  }
});

/**
 * POST /api/auth/recuperar
 * Solicita recuperación de contraseña. Siempre retorna éxito genérico.
 */
router.post('/recuperar', limitadorRecuperacion, async (req, res) => {
  try {
    const { correo } = req.body;

    if (!correo) {
      return res.status(400).json({
        exito: false,
        error: 'Correo electronico es requerido'
      });
    }

    await servicioAuth.solicitarRecuperacion(correo);

    // SEGURIDAD (anti-enumeración): siempre 200 con el mismo cuerpo,
    // sin revelar si el correo existe o no.
    res.json({
      exito: true,
      mensaje: 'Si el correo está registrado, recibirás un enlace de recuperación.'
    });
  } catch (error) {
    console.error('Error en /recuperar:', error);
    res.status(500).json({
      exito: false,
      error: 'Error interno del servidor'
    });
  }
});

/**
 * POST /api/auth/recuperar-por-telefono
 * Solicita recuperación de contraseña por número de teléfono.
 * Siempre retorna respuesta genérica (anti-enumeración).
 */
router.post('/recuperar-por-telefono', limitadorRecuperacion, async (req, res) => {
  try {
    const { telefono } = req.body;

    const resultado = await servicioAuth.recuperarPorTelefono(telefono);

    if (!resultado.exito && resultado.codigo === 'TELEFONO_INVALIDO') {
      return res.status(400).json(resultado);
    }

    // SEGURIDAD (anti-enumeración): siempre 200 con el mismo cuerpo,
    // sin revelar si el teléfono existe o no.
    res.json({
      exito: true,
      mensaje: 'Si el teléfono está registrado, recibirás un correo de recuperación.'
    });
  } catch (error) {
    console.error('Error en /recuperar-por-telefono:', error);
    res.status(500).json({
      exito: false,
      error: 'Error interno del servidor'
    });
  }
});

/**
 * POST /api/auth/restablecer
 * Restablece contraseña con token de recuperación.
 */
router.post('/restablecer', async (req, res) => {
  try {
    const { token, nuevaPassword, confirmarPassword } = req.body;

    if (!token || !nuevaPassword || !confirmarPassword) {
      return res.status(400).json({
        exito: false,
        error: 'Token, nueva contrasena y confirmacion son requeridos'
      });
    }

    const resultado = await servicioAuth.restablecerContrasena(token, nuevaPassword, confirmarPassword);

    if (!resultado.exito) {
      return res.status(resultado.status || 400).json(resultado);
    }

    res.json(resultado);
  } catch (error) {
    console.error('Error en /restablecer:', error);
    res.status(500).json({
      exito: false,
      error: 'Error interno del servidor'
    });
  }
});

/**
 * POST /api/auth/activar
 * Activa una Cuenta_Pendiente estableciendo username y contraseña.
 * Cambia estado de 'pendiente_activacion' a 'activa' y retorna JWT.
 */
router.post('/activar', async (req, res) => {
  try {
    const { correo, password, confirmarPassword } = req.body;

    if (!correo || !password) {
      return res.status(400).json({
        exito: false,
        error: 'Correo y password son requeridos'
      });
    }

    if (confirmarPassword !== undefined && password !== confirmarPassword) {
      return res.status(400).json({
        exito: false,
        error: 'Las contraseñas no coinciden'
      });
    }

    const resultado = await servicioAuth.activarCuenta({
      correo: correo.trim().toLowerCase(),
      password,
      confirmarPassword
    });

    if (!resultado.exito) {
      return res.status(resultado.status || 400).json(resultado);
    }

    res.json(resultado);
  } catch (error) {
    console.error('Error en /activar:', error);
    res.status(500).json({
      exito: false,
      error: 'Error interno del servidor'
    });
  }
});

/**
 * GET /api/auth/consultar-dni/:dni
 * Autocompleta nombre/apellidos desde RENIEC (decolecta) para el registro.
 * PRE-auth: protegido con rate-limit estricto. La UI hace fallback manual si falla.
 */
router.get('/consultar-dni/:dni', limitadorConsultaDni, async (req, res) => {
  try {
    const dni = String(req.params.dni || '').trim();
    if (!/^[0-9]{8}$/.test(dni)) {
      return res.status(400).json({ exito: false, error: 'El DNI debe tener 8 dígitos' });
    }
    const resultado = await servicioDni.consultarDni(dni);
    if (!resultado.exito) {
      return res.status(resultado.status || 502).json(resultado);
    }
    res.json(resultado);
  } catch (error) {
    console.error('Error en /consultar-dni:', error);
    res.status(500).json({ exito: false, error: 'Error interno del servidor' });
  }
});

/**
 * GET /api/auth/perfil
 * Devuelve el perfil propio (correo/teléfono desencriptados) del usuario autenticado.
 */
router.get('/perfil', verificarTokenUsuario, async (req, res) => {
  try {
    const perfil = await servicioAuth.obtenerPerfilPropio(req.usuario.id);
    if (!perfil) {
      return res.status(404).json({ exito: false, error: 'Cuenta no encontrada' });
    }
    res.json({ exito: true, perfil });
  } catch (error) {
    console.error('Error en GET /perfil:', error);
    res.status(500).json({ exito: false, error: 'Error interno del servidor' });
  }
});

/**
 * PUT /api/auth/perfil
 * Actualiza los datos editables de la propia cuenta (teléfono y correo).
 */
router.put('/perfil', verificarTokenUsuario, async (req, res) => {
  try {
    const { telefono, correo } = req.body || {};
    if (!telefono || !correo) {
      return res.status(400).json({ exito: false, error: 'Teléfono y correo son requeridos' });
    }
    const resultado = await servicioAuth.actualizarPerfilPropio(req.usuario.id, {
      telefono: String(telefono).trim(),
      correo: String(correo).trim().toLowerCase()
    });
    if (!resultado.exito) {
      return res.status(resultado.status || 400).json(resultado);
    }
    res.json(resultado);
  } catch (error) {
    console.error('Error en PUT /perfil:', error);
    res.status(500).json({ exito: false, error: 'Error interno del servidor' });
  }
});

/**
 * POST /api/auth/cambiar-contrasena
 * Cambia la contraseña de la propia cuenta (exige la contraseña actual).
 */
router.post('/cambiar-contrasena', verificarTokenUsuario, async (req, res) => {
  try {
    const { contrasena_actual, nueva_password, confirmar_password } = req.body || {};
    if (!contrasena_actual || !nueva_password || !confirmar_password) {
      return res.status(400).json({ exito: false, error: 'Contraseña actual, nueva y confirmación son requeridas' });
    }
    const resultado = await servicioAuth.cambiarContrasenaPropia(req.usuario.id, {
      contrasena_actual,
      nueva_password,
      confirmar_password
    });
    if (!resultado.exito) {
      return res.status(resultado.status || 400).json(resultado);
    }
    res.json(resultado);
  } catch (error) {
    console.error('Error en /cambiar-contrasena:', error);
    res.status(500).json({ exito: false, error: 'Error interno del servidor' });
  }
});

/**
 * POST /api/auth/desactivar-cuenta
 * Baja lógica de la propia cuenta (exige la contraseña).
 */
router.post('/desactivar-cuenta', verificarTokenUsuario, async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) {
      return res.status(400).json({ exito: false, error: 'La contraseña es requerida' });
    }
    const resultado = await servicioAuth.desactivarCuentaPropia(req.usuario.id, { password });
    if (!resultado.exito) {
      return res.status(resultado.status || 400).json(resultado);
    }
    res.json(resultado);
  } catch (error) {
    console.error('Error en /desactivar-cuenta:', error);
    res.status(500).json({ exito: false, error: 'Error interno del servidor' });
  }
});

module.exports = router;