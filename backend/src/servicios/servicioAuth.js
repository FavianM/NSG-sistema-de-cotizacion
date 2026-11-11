/**
 * Servicio de Autenticación
 *
 * Autenticación unificada para admin y usuarios contra tabla cuentas.
 * Incluye login con lockout, registro, recuperación de contraseña,
 * generación y verificación de tokens JWT con rol.
 *
 * Requisitos: 10.1, 10.2, 10.3, 10.4
 */

const bcrypt = require('bcryptjs'); // JS puro: portable, sin binario nativo (compatible con hashes $2a$/$2b$)
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { ejecutarQuery } = require('../configuracion/baseDatos');
const { validarCredenciales, validarRegistro, validarRestablecimiento } = require('../utilidades/validacion');
const { encriptar, hashBusqueda, desencriptar } = require('../utilidades/encriptacion');
const { validarEmail, validarTelefono } = require('../utilidades/sanitizacion');
const { enviarCorreoRecuperacion } = require('./servicioCorreo');

const SALT_ROUNDS = 12;
const MAX_INTENTOS = 5;
const BLOQUEO_MINUTOS = 15;
const TOKEN_EXPIRA_MINUTOS = 5;

/**
 * Autentica un usuario (admin o usuario) contra la tabla cuentas.
 * Incluye bloqueo tras 5 intentos fallidos (15 min).
 *
 * @param {string} username
 * @param {string} password
 * @returns {Promise<Object>}
 */
async function login(correo, password) {
  try {
    const validacion = validarCredenciales({ correo, password });
    if (!validacion.valido) {
      return { exito: false, error: 'Credenciales inválidas', detalles: validacion.errores };
    }

    // Login por correo: se busca por el hash determinístico (correo_hash es único).
    const correoHash = hashBusqueda(String(correo).trim().toLowerCase());
    const resultado = await ejecutarQuery(
      `SELECT id, username, password_hash, nombre_completo, rol,
              estado, intentos_fallidos, bloqueado_hasta
       FROM cuentas WHERE correo_hash = $1`,
      [correoHash]
    );

    if (resultado.rows.length === 0) {
      return { exito: false, error: 'Correo o contraseña incorrectos' };
    }

    const cuenta = resultado.rows[0];

    // Verificar bloqueo
    if (cuenta.bloqueado_hasta && new Date(cuenta.bloqueado_hasta) > new Date()) {
      const minutosRestantes = Math.ceil(
        (new Date(cuenta.bloqueado_hasta) - new Date()) / 60000
      );
      return {
        exito: false,
        error: `Cuenta bloqueada. Intenta nuevamente en ${minutosRestantes} minuto(s).`
      };
    }

    // Verificar estado de la cuenta (Requisito 7.1, 7.3)
    if (cuenta.estado === 'pendiente_activacion') {
      return {
        exito: false,
        status: 403,
        error: 'Cuenta no activada',
        mensaje: 'Debes activar tu cuenta antes de iniciar sesión',
        codigo: 'CUENTA_PENDIENTE'
      };
    }

    const passwordValido = await bcrypt.compare(password, cuenta.password_hash);

    if (!passwordValido) {
      const nuevosIntentos = cuenta.intentos_fallidos + 1;
      if (nuevosIntentos >= MAX_INTENTOS) {
        await ejecutarQuery(
          `UPDATE cuentas SET intentos_fallidos = 0, bloqueado_hasta = CURRENT_TIMESTAMP + ($2 * interval '1 minute') WHERE id = $1`,
          [cuenta.id, BLOQUEO_MINUTOS]
        );
        return {
          exito: false,
          error: `Cuenta bloqueada por ${BLOQUEO_MINUTOS} minutos tras ${MAX_INTENTOS} intentos fallidos.`
        };
      }
      await ejecutarQuery(
        'UPDATE cuentas SET intentos_fallidos = $1 WHERE id = $2',
        [nuevosIntentos, cuenta.id]
      );
      return { exito: false, error: 'Correo o contraseña incorrectos' };
    }

    // Login exitoso: resetear intentos y bloqueo
    await ejecutarQuery(
      'UPDATE cuentas SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1',
      [cuenta.id]
    );

    const token = generarToken({
      id: cuenta.id,
      username: cuenta.username,
      nombre: cuenta.nombre_completo,
      rol: cuenta.rol
    });

    return {
      exito: true,
      token,
      usuario: {
        id: cuenta.id,
        username: cuenta.username,
        nombre: cuenta.nombre_completo,
        rol: cuenta.rol
      }
    };
  } catch (error) {
    console.error('Error en login:', error);
    return { exito: false, error: 'Error al procesar la autenticación' };
  }
}

/**
 * Registra un nuevo usuario con rol 'usuario'.
 * El correo se cifra con AES-256-CBC y se indexa con HMAC-SHA256.
 *
 * @param {Object} datos - { username, password, confirmarPassword, correo, nombre_completo, telefono }
 * @returns {Promise<Object>}
 */
async function registrar(datos) {
  try {
    const validacion = validarRegistro(datos);
    if (!validacion.valido) {
      return { exito: false, status: 400, error: 'Datos inválidos', detalles: validacion.errores };
    }

    const correoNormalizado = datos.correo.trim().toLowerCase();
    const correoHash = hashBusqueda(correoNormalizado);
    const dni = String(datos.dni || '').trim() || null;
    const nombre = datos.nombre.trim();
    const apellidos = datos.apellidos.trim();
    const nombreCompleto = `${nombre} ${apellidos}`.replace(/\s+/g, ' ').trim();

    // Dedup por correo (vía hash). Si la cuenta existe y está pendiente, se enruta a activar.
    const correoExiste = await ejecutarQuery(
      'SELECT id, estado FROM cuentas WHERE correo_hash = $1',
      [correoHash]
    );
    if (correoExiste.rows.length > 0) {
      const cuentaExistente = correoExiste.rows[0];
      if (cuentaExistente.estado === 'pendiente_activacion') {
        return {
          exito: false,
          status: 409,
          error: 'Correo con cuenta pendiente de activación',
          codigo: 'CUENTA_PENDIENTE_ACTIVACION',
          mensaje: 'Este correo ya tiene cotizaciones asociadas. Activa tu cuenta para acceder a ellas.'
        };
      }
      return {
        exito: false,
        status: 409,
        error: 'El correo electrónico ya está registrado',
        codigo: 'CORREO_DUPLICADO',
        mensaje: 'Ya existe una cuenta con ese correo. Inicia sesión o recupera tu contraseña.'
      };
    }

    // Dedup por DNI (índice único parcial uq_cuentas_dni).
    if (dni) {
      const dniExiste = await ejecutarQuery('SELECT id FROM cuentas WHERE dni = $1', [dni]);
      if (dniExiste.rows.length > 0) {
        return {
          exito: false,
          status: 409,
          error: 'Ya existe una cuenta con ese DNI',
          codigo: 'DNI_DUPLICADO',
          mensaje: 'Ya hay una cuenta registrada con ese DNI.'
        };
      }
    }

    const correoEncrypted = encriptar(correoNormalizado);

    let telefonoEncrypted = null;
    let telefonoHash = null;
    if (datos.telefono) {
      const telefonoLimpio = String(datos.telefono).trim();
      telefonoEncrypted = encriptar(telefonoLimpio);
      telefonoHash = hashBusqueda(telefonoLimpio);
    }

    const passwordHash = await hashPassword(datos.password);

    // username queda NULL (login por correo). nombre_completo se mantiene derivado.
    const insert = await ejecutarQuery(
      `INSERT INTO cuentas (password_hash, correo_encrypted, correo_hash, nombre, apellidos, nombre_completo, telefono_encrypted, telefono_hash, dni, rol)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'usuario')
       RETURNING id, nombre_completo, rol`,
      [passwordHash, correoEncrypted, correoHash, nombre, apellidos, nombreCompleto, telefonoEncrypted, telefonoHash, dni]
    );

    const cuenta = insert.rows[0];

    const token = generarToken({
      id: cuenta.id,
      username: null,
      nombre: cuenta.nombre_completo,
      rol: cuenta.rol
    });

    return {
      exito: true,
      token,
      usuario: {
        id: cuenta.id,
        username: null,
        nombre: cuenta.nombre_completo,
        rol: cuenta.rol
      }
    };
  } catch (error) {
    // Carrera en la unicidad de correo_hash / dni → respuesta amigable.
    if (error && error.code === '23505') {
      return { exito: false, status: 409, error: 'Ya existe una cuenta con ese correo o DNI', codigo: 'DUPLICADO' };
    }
    console.error('Error en registrar:', error);
    return { exito: false, status: 500, error: 'Error al procesar el registro' };
  }
}

/**
 * Solicita recuperación de contraseña: genera token y lo guarda.
 * Siempre retorna éxito genérico (anti-enumeración de correos).
 *
 * @param {string} correo
 * @returns {Promise<Object>}
 */
async function solicitarRecuperacion(correo) {
  try {
    const correoNormalizado = correo.trim().toLowerCase();
    let correoHash;
    try {
      correoHash = hashBusqueda(correoNormalizado);
    } catch {
      return { exito: false, encontrado: false, mensaje: 'Cuenta no encontrada.' };
    }

    const resultado = await ejecutarQuery(
      'SELECT id FROM cuentas WHERE correo_hash = $1',
      [correoHash]
    );

    if (resultado.rows.length === 0) {
      return { exito: false, encontrado: false, mensaje: 'Cuenta no encontrada.' };
    }

    const cuenta = resultado.rows[0];
    const tokenRecuperacion = crypto.randomBytes(32).toString('hex');
    const expira = new Date(Date.now() + TOKEN_EXPIRA_MINUTOS * 60 * 1000);

    await ejecutarQuery(
      'UPDATE cuentas SET token_recuperacion = $1, token_recuperacion_expira = $2 WHERE id = $3',
      [tokenRecuperacion, expira, cuenta.id]
    );

    const enlace = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/restablecer?token=${tokenRecuperacion}`;
    enviarCorreoRecuperacion(correoNormalizado, enlace)
      .then(() => {
        console.log(`[RECUPERACION] Correo enviado para cuenta ${cuenta.id}`);
        console.log(`[RECUPERACION] Expira: ${expira.toISOString()}`);
      })
      .catch((errorCorreo) => {
        console.error(`[RECUPERACION] Falló envío para cuenta ${cuenta.id}:`, errorCorreo);
      });

    return { exito: true, encontrado: true, mensaje: 'Correo enviado. Revisa tu bandeja de entrada.' };
  } catch (error) {
    console.error('Error en solicitarRecuperacion:', error);
    return { exito: false, encontrado: false, mensaje: 'Error al procesar la solicitud. Intenta nuevamente.' };
  }
}

/**
 * Restablece la contraseña usando un token de recuperación.
 *
 * @param {string} token
 * @param {string} nuevaPassword
 * @param {string} confirmarPassword
 * @returns {Promise<Object>}
 */
async function restablecerContrasena(token, nuevaPassword, confirmarPassword) {
  try {
    // Validar inputs
    const validacion = validarRestablecimiento({ token, nuevaPassword, confirmarPassword });
    if (!validacion.valido) {
      return { exito: false, status: 400, error: 'Datos inválidos', detalles: validacion.errores };
    }

    // Buscar cuenta con token válido y no expirado
    const resultado = await ejecutarQuery(
      `SELECT id FROM cuentas
       WHERE token_recuperacion = $1
         AND token_recuperacion_expira IS NOT NULL
         AND token_recuperacion_expira > CURRENT_TIMESTAMP`,
      [token]
    );

    if (resultado.rows.length === 0) {
      return { exito: false, status: 400, error: 'El enlace de recuperación no es válido o ha expirado.' };
    }

    const cuenta = resultado.rows[0];
    const passwordHash = await hashPassword(nuevaPassword);

    await ejecutarQuery(
      `UPDATE cuentas
       SET password_hash = $1,
           token_recuperacion = NULL,
           token_recuperacion_expira = NULL,
           intentos_fallidos = 0,
           bloqueado_hasta = NULL
       WHERE id = $2`,
      [passwordHash, cuenta.id]
    );

    return { exito: true, mensaje: 'Contraseña restablecida exitosamente. Ya puedes iniciar sesión.' };
  } catch (error) {
    console.error('Error en restablecerContrasena:', error);
    return { exito: false, status: 500, error: 'Error al restablecer la contraseña' };
  }
}

/**
 * Genera un token JWT con rol incluido.
 *
 * Expiración de 8 horas: limita la ventana de uso de un token robado
 * (antes 24h). Configurable vía JWT_EXPIRACION si se necesita ajustar.
 *
 * @param {Object} payload - { id, username, nombre, rol }
 * @param {string} [expiracion]
 * @returns {string}
 */
function generarToken(payload, expiracion = process.env.JWT_EXPIRACION || '8h') {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET no está configurado en las variables de entorno');
  }

  return jwt.sign(
    { id: payload.id, username: payload.username, nombre: payload.nombre, rol: payload.rol },
    process.env.JWT_SECRET,
    { expiresIn: expiracion, issuer: 'nsg-cotizacion-system' }
  );
}

/**
 * Verifica un token JWT y retorna el payload incluyendo rol.
 *
 * @param {string} token
 * @returns {Object} { valido, payload?, error? }
 */
function verificarToken(token) {
  try {
    if (!token) {
      return { valido: false, error: 'Token no proporcionado' };
    }

    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET no está configurado en las variables de entorno');
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);

    return {
      valido: true,
      payload: {
        id: payload.id,
        username: payload.username,
        nombre: payload.nombre,
        rol: payload.rol || 'usuario' // SEGURIDAD: sin rol => minimo privilegio
      }
    };
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return { valido: false, error: 'Token expirado' };
    }
    if (error.name === 'JsonWebTokenError') {
      return { valido: false, error: 'Token inválido' };
    }
    return { valido: false, error: 'Error al verificar el token' };
  }
}

/**
 * Hashea contraseña con bcrypt (rondas 12).
 *
 * @param {string} password
 * @param {number} [saltRounds=12]
 * @returns {Promise<string>}
 */
async function hashPassword(password, saltRounds = SALT_ROUNDS) {
  try {
    return await bcrypt.hash(password, saltRounds);
  } catch (error) {
    console.error('Error al hashear contraseña:', error);
    throw new Error('Error al procesar la contraseña');
  }
}

/**
 * Verifica contraseña contra hash.
 *
 * @param {string} password
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
async function verificarPassword(password, hash) {
  try {
    return await bcrypt.compare(password, hash);
  } catch (error) {
    console.error('Error al verificar contraseña:', error);
    return false;
  }
}

/**
 * Obtiene información de una cuenta por ID.
 *
 * @param {number} id
 * @returns {Promise<Object|null>}
 */
async function obtenerCuentaPorId(id) {
  try {
    const resultado = await ejecutarQuery(
      'SELECT id, username, nombre_completo, rol, created_at FROM cuentas WHERE id = $1',
      [id]
    );

    if (resultado.rows.length === 0) return null;
    return resultado.rows[0];
  } catch (error) {
    console.error('Error al obtener cuenta:', error);
    throw error;
  }
}

/**
 * Activa una Cuenta_Pendiente estableciendo la contraseña (login por correo:
 * ya no se pide username). Cambia estado de 'pendiente_activacion' a 'activa'.
 *
 * @param {Object} datos - { correo, password, confirmarPassword }
 * @returns {Promise<Object>}
 */
async function activarCuenta(datos) {
  try {
    const { correo, password, confirmarPassword } = datos;

    // 1. Validar inputs (login por correo: sin username)
    if (!correo) {
      return { exito: false, status: 400, error: 'El correo es requerido', codigo: 'CORREO_REQUERIDO' };
    }
    if (!password || password.length < 8) {
      return { exito: false, status: 400, error: 'La contraseña debe tener al menos 8 caracteres', codigo: 'PASSWORD_INVALIDO' };
    }
    if (confirmarPassword !== undefined && password !== confirmarPassword) {
      return { exito: false, status: 400, error: 'Las contraseñas no coinciden', codigo: 'PASSWORD_NO_COINCIDE' };
    }

    // 2. Buscar cuenta por correo_hash con estado='pendiente_activacion'
    const correoNormalizado = correo.trim().toLowerCase();
    const correoHash = hashBusqueda(correoNormalizado);

    const resultadoCuenta = await ejecutarQuery(
      "SELECT id, nombre_completo, rol FROM cuentas WHERE correo_hash = $1 AND estado = 'pendiente_activacion'",
      [correoHash]
    );

    if (resultadoCuenta.rows.length === 0) {
      return { exito: false, status: 404, error: 'Cuenta pendiente no encontrada para ese correo', codigo: 'CUENTA_NO_ENCONTRADA' };
    }

    const cuenta = resultadoCuenta.rows[0];

    // 3. Hashear contraseña
    const passwordHash = await hashPassword(password);

    // 4. Activar cuenta (sin tocar username)
    await ejecutarQuery(
      `UPDATE cuentas
       SET password_hash = $1, estado = 'activa',
           intentos_fallidos = 0, bloqueado_hasta = NULL, updated_at = NOW()
       WHERE correo_hash = $2 AND estado = 'pendiente_activacion'`,
      [passwordHash, correoHash]
    );

    // 5. Generar JWT y retornar
    const token = generarToken({
      id: cuenta.id,
      username: null,
      nombre: cuenta.nombre_completo,
      rol: cuenta.rol
    });

    return {
      exito: true,
      token,
      usuario: {
        id: cuenta.id,
        username: null,
        nombre: cuenta.nombre_completo,
        rol: cuenta.rol
      }
    };
  } catch (error) {
    console.error('Error en activarCuenta:', error);
    return { exito: false, status: 500, error: 'Error al activar la cuenta' };
  }
}

/**
 * Solicita recuperación de contraseña por número de teléfono.
 * Siempre retorna respuesta genérica (anti-enumeración).
 *
 * @param {string} telefono
 * @returns {Promise<Object>}
 */
async function recuperarPorTelefono(telefono) {
  // 1. Validar formato de teléfono
  if (!telefono || !/^\d{7,15}$/.test(telefono)) {
    return { exito: false, status: 400, codigo: 'TELEFONO_INVALIDO' };
  }

  try {
    // 2. Calcular hash del teléfono (mismo patrón que hashBusqueda)
    const telefonoHash = hashBusqueda(telefono);

    // 3. Buscar en cuentas por telefono_hash
    const resultado = await ejecutarQuery(
      'SELECT id, correo_encrypted FROM cuentas WHERE telefono_hash = $1',
      [telefonoHash]
    );

    if (resultado.rows.length === 0) {
      return { exito: false, encontrado: false, mensaje: 'Cuenta no encontrada.' };
    }

    const cuenta = resultado.rows[0];

    // 4. Generar token de recuperación
    const tokenRecuperacion = crypto.randomBytes(32).toString('hex');
    const expira = new Date(Date.now() + TOKEN_EXPIRA_MINUTOS * 60 * 1000);

    await ejecutarQuery(
      'UPDATE cuentas SET token_recuperacion = $1, token_recuperacion_expira = $2 WHERE id = $3',
      [tokenRecuperacion, expira, cuenta.id]
    );

    // 5. Desencriptar correo y enviar enlace de recuperación
    try {
      const correoDesencriptado = desencriptar(cuenta.correo_encrypted);
      const enlace = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/restablecer?token=${tokenRecuperacion}`;
      enviarCorreoRecuperacion(correoDesencriptado, enlace)
        .then(() => {
          console.log(`[RECUPERACION_TELEFONO] Correo enviado para cuenta ${cuenta.id}`);
        })
        .catch((errorCorreo) => {
          console.error(`[RECUPERACION_TELEFONO] Falló envío para cuenta ${cuenta.id}:`, errorCorreo);
        });
    } catch (errorDesencriptar) {
      console.error(`[RECUPERACION_TELEFONO] Error al desencriptar correo para cuenta ${cuenta.id}:`, errorDesencriptar);
    }

    return { exito: true, encontrado: true, mensaje: 'Correo enviado. Revisa la bandeja de entrada asociada a este número.' };
  } catch (error) {
    console.error('Error en recuperarPorTelefono:', error);
    return { exito: false, encontrado: false, mensaje: 'Error al procesar la solicitud. Intenta nuevamente.' };
  }
}

/**
 * Obtiene el perfil propio (cuenta del usuario autenticado) con correo y
 * teléfono desencriptados. El JWT no incluye estos datos, así que este es el
 * origen para poblar el formulario de cuenta.
 *
 * @param {number} id
 * @returns {Promise<Object|null>}
 */
async function obtenerPerfilPropio(id) {
  const resultado = await ejecutarQuery(
    'SELECT id, username, nombre, apellidos, nombre_completo, rol, estado, dni, correo_encrypted, telefono_encrypted FROM cuentas WHERE id = $1',
    [id]
  );
  if (resultado.rows.length === 0) return null;
  const c = resultado.rows[0];
  const desc = (valor) => {
    if (!valor) return null;
    try { return desencriptar(valor); } catch { return null; }
  };
  return {
    id: c.id,
    username: c.username,
    nombre: c.nombre || null,
    apellidos: c.apellidos || null,
    nombre_completo: c.nombre_completo,
    rol: c.rol,
    estado: c.estado,
    dni: c.dni || null,
    correo: desc(c.correo_encrypted),
    telefono: desc(c.telefono_encrypted)
  };
}

/**
 * Actualiza los datos editables de la propia cuenta: teléfono y correo.
 * Reescribe SIEMPRE las columnas _encrypted y _hash. Valida unicidad del
 * correo excluyendo la cuenta propia. (Nombre/DNI/rol/estado no se tocan.)
 *
 * @param {number} id
 * @param {{ telefono: string, correo: string }} datos
 */
async function actualizarPerfilPropio(id, { telefono, correo }) {
  const vCorreo = validarEmail(correo);
  if (!vCorreo.valido) {
    return { exito: false, status: 400, error: vCorreo.error || 'Correo inválido' };
  }
  const vTelefono = validarTelefono(telefono);
  if (!vTelefono.valido) {
    return { exito: false, status: 400, error: vTelefono.error || 'Teléfono inválido' };
  }

  const correoNormalizado = vCorreo.email;
  const telefonoNormalizado = vTelefono.telefono;
  const correoHash = hashBusqueda(correoNormalizado);

  // Unicidad de correo (excluyendo la propia cuenta).
  const duplicado = await ejecutarQuery(
    'SELECT id FROM cuentas WHERE correo_hash = $1 AND id <> $2',
    [correoHash, id]
  );
  if (duplicado.rows.length > 0) {
    return { exito: false, status: 409, error: 'El correo ya está en uso por otra cuenta' };
  }

  await ejecutarQuery(
    `UPDATE cuentas
        SET correo_encrypted = $1, correo_hash = $2,
            telefono_encrypted = $3, telefono_hash = $4,
            updated_at = NOW()
      WHERE id = $5`,
    [encriptar(correoNormalizado), correoHash, encriptar(telefonoNormalizado), hashBusqueda(telefonoNormalizado), id]
  );

  return { exito: true, mensaje: 'Datos actualizados', perfil: await obtenerPerfilPropio(id) };
}

/**
 * Cambia la contraseña de la propia cuenta exigiendo la contraseña actual.
 *
 * @param {number} id
 * @param {{ contrasena_actual: string, nueva_password: string, confirmar_password: string }} datos
 */
async function cambiarContrasenaPropia(id, { contrasena_actual, nueva_password, confirmar_password }) {
  const errores = [];
  if (!nueva_password || nueva_password.length < 8) {
    errores.push('La contraseña debe tener al menos 8 caracteres');
  } else {
    if (!/[A-Z]/.test(nueva_password)) errores.push('Debe contener al menos una mayúscula');
    if (!/[a-z]/.test(nueva_password)) errores.push('Debe contener al menos una minúscula');
    if (!/[0-9]/.test(nueva_password)) errores.push('Debe contener al menos un número');
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(nueva_password)) errores.push('Debe contener al menos un carácter especial');
  }
  if (nueva_password !== confirmar_password) errores.push('Las contraseñas no coinciden');
  if (errores.length > 0) {
    return { exito: false, status: 400, error: 'Datos inválidos', detalles: errores };
  }

  const resultado = await ejecutarQuery('SELECT password_hash FROM cuentas WHERE id = $1', [id]);
  if (resultado.rows.length === 0) {
    return { exito: false, status: 404, error: 'Cuenta no encontrada' };
  }

  const actualOk = await verificarPassword(contrasena_actual || '', resultado.rows[0].password_hash);
  if (!actualOk) {
    // 400 (no 401): la sesión es válida, solo el campo "contraseña actual" es
    // incorrecto. Un 401 dispararía el logout global del interceptor de axios.
    return { exito: false, status: 400, error: 'La contraseña actual es incorrecta' };
  }

  const passwordHash = await hashPassword(nueva_password);
  await ejecutarQuery('UPDATE cuentas SET password_hash = $1, updated_at = NOW() WHERE id = $2', [passwordHash, id]);
  return { exito: true, mensaje: 'Contraseña actualizada correctamente' };
}

/**
 * Baja lógica de la propia cuenta. Exige la contraseña. No borra datos:
 * cambia estado a 'desactivada' (el middleware corta el acceso en el
 * siguiente request). Reversible por un admin.
 *
 * @param {number} id
 * @param {{ password: string }} datos
 */
async function desactivarCuentaPropia(id, { password }) {
  const resultado = await ejecutarQuery('SELECT password_hash FROM cuentas WHERE id = $1', [id]);
  if (resultado.rows.length === 0) {
    return { exito: false, status: 404, error: 'Cuenta no encontrada' };
  }

  const passwordOk = await verificarPassword(password || '', resultado.rows[0].password_hash);
  if (!passwordOk) {
    // 400 (no 401): evita el logout global del interceptor; la sesión sigue siendo válida.
    return { exito: false, status: 400, error: 'La contraseña es incorrecta' };
  }

  await ejecutarQuery("UPDATE cuentas SET estado = 'desactivada', updated_at = NOW() WHERE id = $1", [id]);
  return { exito: true, mensaje: 'Tu cuenta fue dada de baja' };
}

// Retrocompatibilidad
const obtenerAdministradorPorId = obtenerCuentaPorId;

module.exports = {
  login,
  registrar,
  activarCuenta,
  solicitarRecuperacion,
  recuperarPorTelefono,
  restablecerContrasena,
  generarToken,
  verificarToken,
  hashPassword,
  verificarPassword,
  obtenerCuentaPorId,
  obtenerAdministradorPorId,
  obtenerPerfilPropio,
  actualizarPerfilPropio,
  cambiarContrasenaPropia,
  desactivarCuentaPropia
};
