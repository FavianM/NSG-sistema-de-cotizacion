/**
 * Módulo de Validación de Datos
 * 
 * Proporciona funciones para validar estructuras de datos complejas
 * del sistema de cotización.
 * 
 * Uso:
 * - Validar datos de productos antes de insertar/actualizar
 * - Validar datos de cotizaciones
 * - Validar configuraciones de componentes
 * 
 * Requisitos: 10.1, 10.2, 10.3, 10.4
 */

const { validarEmail, validarTelefono, validarSinCodigoMalicioso } = require('./sanitizacion');

/**
 * Valida los datos de un producto
 * 
 * @param {Object} datos - Datos del producto
 * @returns {Object} { valido: boolean, errores: Array }
 * 
 * @example
 * validarProducto({ nombre: 'Intel i7', precio_base: 500, stock: 10 });
 */
function validarProducto(datos) {
  const errores = [];
  
  // Validar nombre
  if (!datos.nombre || typeof datos.nombre !== 'string') {
    errores.push({ campo: 'nombre', mensaje: 'Nombre es requerido' });
  } else if (datos.nombre.trim().length < 3) {
    errores.push({ campo: 'nombre', mensaje: 'Nombre debe tener mínimo 3 caracteres' });
  } else if (datos.nombre.length > 200) {
    errores.push({ campo: 'nombre', mensaje: 'Nombre debe tener máximo 200 caracteres' });
  } else {
    const validacionCodigo = validarSinCodigoMalicioso(datos.nombre);
    if (!validacionCodigo.valido) {
      errores.push({ campo: 'nombre', mensaje: validacionCodigo.error });
    }
  }
  
  // Validar categoría
  const categoriasValidas = [
    'procesador', 
    'placa_madre', 
    'ram', 
    'almacenamiento', 
    'gpu', 
    'fuente', 
    'case'
  ];
  
  if (!datos.categoria) {
    errores.push({ campo: 'categoria', mensaje: 'Categoría es requerida' });
  } else if (!categoriasValidas.includes(datos.categoria)) {
    errores.push({ 
      campo: 'categoria', 
      mensaje: `Categoría debe ser una de: ${categoriasValidas.join(', ')}` 
    });
  }
  
  // Validar precio_base
  if (datos.precio_base === undefined || datos.precio_base === null) {
    errores.push({ campo: 'precio_base', mensaje: 'Precio base es requerido' });
  } else if (isNaN(datos.precio_base) || datos.precio_base <= 0) {
    errores.push({ campo: 'precio_base', mensaje: 'Precio base debe ser un número positivo' });
  } else if (datos.precio_base > 100000) {
    errores.push({ campo: 'precio_base', mensaje: 'Precio base excede el máximo permitido' });
  }
  
  // Validar stock
  if (datos.stock === undefined || datos.stock === null) {
    errores.push({ campo: 'stock', mensaje: 'Stock es requerido' });
  } else if (!Number.isInteger(datos.stock) || datos.stock < 0) {
    errores.push({ campo: 'stock', mensaje: 'Stock debe ser un número entero no negativo' });
  }
  
  // Validar disponible_a_pedido (opcional)
  if (datos.disponible_a_pedido !== undefined && typeof datos.disponible_a_pedido !== 'boolean') {
    errores.push({ campo: 'disponible_a_pedido', mensaje: 'Debe ser un valor booleano' });
  }
  
  // Validar tiempo_entrega_dias (opcional)
  if (
    datos.tiempo_entrega_dias !== undefined &&
    datos.tiempo_entrega_dias !== null &&
    datos.tiempo_entrega_dias !== ''
  ) {
    if (!Number.isInteger(datos.tiempo_entrega_dias) || datos.tiempo_entrega_dias < 0) {
      errores.push({ campo: 'tiempo_entrega_dias', mensaje: 'Debe ser un número entero no negativo' });
    }
  }
  
  // Validar socket (opcional, pero requerido para procesador y placa_madre)
  if (['procesador', 'placa_madre'].includes(datos.categoria)) {
    if (!datos.socket || typeof datos.socket !== 'string') {
      errores.push({ campo: 'socket', mensaje: 'Socket es requerido para esta categoría' });
    }
  }
  
  // Validar ram_type (opcional, pero requerido para ram y placa_madre)
  if (['ram', 'placa_madre'].includes(datos.categoria)) {
    if (!datos.ram_type || typeof datos.ram_type !== 'string') {
      errores.push({ campo: 'ram_type', mensaje: 'Tipo de RAM es requerido para esta categoría' });
    }
  }
  
  // Validar form_factor (opcional, pero requerido para placa_madre y case)
  if (['placa_madre', 'case'].includes(datos.categoria)) {
    if (!datos.form_factor || typeof datos.form_factor !== 'string') {
      errores.push({ campo: 'form_factor', mensaje: 'Form factor es requerido para esta categoría' });
    }
  }
  
  // Validar wattage (opcional, pero requerido para fuente)
  if (datos.categoria === 'fuente') {
    if (!datos.wattage || isNaN(datos.wattage) || datos.wattage <= 0) {
      errores.push({ campo: 'wattage', mensaje: 'Wattage es requerido y debe ser positivo para fuentes' });
    }
  }
  
  // Validar tdp (opcional, pero requerido para procesador y gpu)
  if (['procesador', 'gpu'].includes(datos.categoria)) {
    if (!datos.tdp || isNaN(datos.tdp) || datos.tdp <= 0) {
      errores.push({ campo: 'tdp', mensaje: 'TDP es requerido y debe ser positivo para esta categoría' });
    }
  }
  
  return {
    valido: errores.length === 0,
    errores
  };
}

/**
 * Valida los datos de un cliente
 * 
 * @param {Object} datos - Datos del cliente
 * @returns {Object} { valido: boolean, errores: Array }
 */
function validarCliente(datos) {
  const errores = [];
  
  // Validar nombre (opcional)
  if (datos.nombre !== undefined && datos.nombre !== null) {
    if (typeof datos.nombre !== 'string') {
      errores.push({ campo: 'nombre', mensaje: 'Nombre debe ser un string' });
    } else if (datos.nombre.trim().length < 2) {
      errores.push({ campo: 'nombre', mensaje: 'Nombre debe tener mínimo 2 caracteres' });
    } else if (datos.nombre.length > 100) {
      errores.push({ campo: 'nombre', mensaje: 'Nombre debe tener máximo 100 caracteres' });
    }
  }
  
  // Validar correo (requerido)
  if (!datos.correo) {
    errores.push({ campo: 'correo', mensaje: 'Correo es requerido' });
  } else {
    const validacionEmail = validarEmail(datos.correo);
    if (!validacionEmail.valido) {
      errores.push({ campo: 'correo', mensaje: validacionEmail.error });
    }
  }
  
  // Validar teléfono (opcional)
  if (datos.telefono !== undefined && datos.telefono !== null && datos.telefono !== '') {
    const validacionTelefono = validarTelefono(datos.telefono);
    if (!validacionTelefono.valido) {
      errores.push({ campo: 'telefono', mensaje: validacionTelefono.error });
    }
  }
  
  return {
    valido: errores.length === 0,
    errores
  };
}

/**
 * Valida los datos de una cotización
 * 
 * @param {Object} datos - Datos de la cotización
 * @returns {Object} { valido: boolean, errores: Array }
 */
function validarCotizacion(datos) {
  const errores = [];
  
  // Validar componentes
  if (!datos.componentes || !Array.isArray(datos.componentes)) {
    errores.push({ campo: 'componentes', mensaje: 'Componentes debe ser un array' });
  } else if (datos.componentes.length === 0) {
    errores.push({ campo: 'componentes', mensaje: 'Debe incluir al menos un componente' });
  } else if (datos.componentes.length > 20) {
    errores.push({ campo: 'componentes', mensaje: 'Máximo 20 componentes permitidos' });
  }
  
  // Validar precio_total
  if (datos.precio_total === undefined || datos.precio_total === null) {
    errores.push({ campo: 'precio_total', mensaje: 'Precio total es requerido' });
  } else if (isNaN(datos.precio_total) || datos.precio_total <= 0) {
    errores.push({ campo: 'precio_total', mensaje: 'Precio total debe ser un número positivo' });
  }
  
  // Validar margen_aplicado
  if (datos.margen_aplicado === undefined || datos.margen_aplicado === null) {
    errores.push({ campo: 'margen_aplicado', mensaje: 'Margen aplicado es requerido' });
  } else if (isNaN(datos.margen_aplicado) || datos.margen_aplicado < 0 || datos.margen_aplicado > 100) {
    errores.push({ campo: 'margen_aplicado', mensaje: 'Margen debe estar entre 0 y 100' });
  }
  
  // Validar email del cliente (opcional)
  if (datos.email_cliente) {
    const validacionEmail = validarEmail(datos.email_cliente);
    if (!validacionEmail.valido) {
      errores.push({ campo: 'email_cliente', mensaje: validacionEmail.error });
    }
  }
  
  return {
    valido: errores.length === 0,
    errores
  };
}

/**
 * Valida el estado de una cotización
 * 
 * @param {string} estado - Estado a validar
 * @returns {Object} { valido: boolean, error?: string }
 */
function validarEstadoCotizacion(estado) {
  const estadosValidos = ['Pendiente', 'Confirmada', 'Completada', 'Caducada', 'Reclamada'];
  
  if (!estado || typeof estado !== 'string') {
    return { valido: false, error: 'Estado es requerido' };
  }
  
  if (!estadosValidos.includes(estado)) {
    return { 
      valido: false, 
      error: `Estado debe ser uno de: ${estadosValidos.join(', ')}` 
    };
  }
  
  return { valido: true };
}

/**
 * Valida un margen de ganancia
 * 
 * @param {number} margen - Margen a validar
 * @returns {Object} { valido: boolean, error?: string }
 */
function validarMargen(margen) {
  if (margen === undefined || margen === null) {
    return { valido: false, error: 'Margen es requerido' };
  }
  
  if (isNaN(margen)) {
    return { valido: false, error: 'Margen debe ser un número' };
  }
  
  if (margen < 0 || margen > 100) {
    return { valido: false, error: 'Margen debe estar entre 0 y 100' };
  }
  
  return { valido: true };
}

/**
 * Valida un ID (debe ser entero positivo)
 * 
 * @param {any} id - ID a validar
 * @returns {Object} { valido: boolean, error?: string }
 */
function validarId(id) {
  if (id === undefined || id === null) {
    return { valido: false, error: 'ID es requerido' };
  }
  
  const idNum = parseInt(id, 10);
  
  if (isNaN(idNum) || idNum <= 0 || !Number.isInteger(idNum)) {
    return { valido: false, error: 'ID debe ser un número entero positivo' };
  }
  
  return { valido: true, id: idNum };
}

/**
 * Valida un código de ticket (formato NSG-YYYY-NNNN)
 * 
 * @param {string} codigo - Código a validar
 * @returns {Object} { valido: boolean, error?: string }
 */
function validarCodigoTicket(codigo) {
  if (!codigo || typeof codigo !== 'string') {
    return { valido: false, error: 'Código de ticket es requerido' };
  }
  
  // Formato: NSG-YYYY-NNNN
  const patron = /^NSG-\d{4}-\d{4}$/;
  
  if (!patron.test(codigo)) {
    return { 
      valido: false, 
      error: 'Formato de código inválido (debe ser NSG-YYYY-NNNN)' 
    };
  }
  
  return { valido: true };
}

/**
 * Valida credenciales de login
 * 
 * @param {Object} credenciales - { username, password }
 * @returns {Object} { valido: boolean, errores: Array }
 */
function validarCredenciales(credenciales) {
  const errores = [];

  // Login por correo electrónico.
  if (!credenciales.correo || typeof credenciales.correo !== 'string') {
    errores.push({ campo: 'correo', mensaje: 'Correo es requerido' });
  } else {
    const validacionEmail = validarEmail(credenciales.correo);
    if (!validacionEmail.valido) {
      errores.push({ campo: 'correo', mensaje: validacionEmail.error || 'Correo inválido' });
    }
  }

  if (!credenciales.password || typeof credenciales.password !== 'string') {
    errores.push({ campo: 'password', mensaje: 'Password es requerido' });
  } else if (credenciales.password.length < 6) {
    errores.push({ campo: 'password', mensaje: 'Password debe tener mínimo 6 caracteres' });
  }
  
  return {
    valido: errores.length === 0,
    errores
  };
}

/**
 * Valida los datos de registro de usuario.
 *
 * @param {Object} datos - { username, password, confirmarPassword, correo, nombre_completo, telefono? }
 * @returns {Object} { valido: boolean, errores: Array }
 */
function validarRegistro(datos) {
  const errores = [];

  // Login por correo: ya no se exige username.

  // Password: requerido, min 8 chars, mayuscula, minuscula, numero, especial
  if (!datos.password || typeof datos.password !== 'string') {
    errores.push({ campo: 'password', mensaje: 'Contrasena es requerida' });
  } else {
    if (datos.password.length < 8) {
      errores.push({ campo: 'password', mensaje: 'Contrasena debe tener minimo 8 caracteres' });
    }
    if (!/[A-Z]/.test(datos.password)) {
      errores.push({ campo: 'password', mensaje: 'Contrasena debe contener al menos una letra mayuscula' });
    }
    if (!/[a-z]/.test(datos.password)) {
      errores.push({ campo: 'password', mensaje: 'Contrasena debe contener al menos una letra minuscula' });
    }
    if (!/[0-9]/.test(datos.password)) {
      errores.push({ campo: 'password', mensaje: 'Contrasena debe contener al menos un numero' });
    }
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(datos.password)) {
      errores.push({ campo: 'password', mensaje: 'Contrasena debe contener al menos un caracter especial' });
    }
  }

  // Confirmar password
  if (datos.password !== datos.confirmarPassword) {
    errores.push({ campo: 'confirmarPassword', mensaje: 'Las contrasenas no coinciden' });
  }

  // Correo: requerido, formato válido
  if (!datos.correo) {
    errores.push({ campo: 'correo', mensaje: 'Correo electronico es requerido' });
  } else {
    const validacionEmail = validarEmail(datos.correo);
    if (!validacionEmail.valido) {
      errores.push({ campo: 'correo', mensaje: validacionEmail.error });
    }
  }

  // Nombre: requerido, 2-60 chars
  if (!datos.nombre || typeof datos.nombre !== 'string' || datos.nombre.trim().length < 2) {
    errores.push({ campo: 'nombre', mensaje: 'El nombre es obligatorio (mínimo 2 caracteres)' });
  } else if (datos.nombre.trim().length > 60) {
    errores.push({ campo: 'nombre', mensaje: 'El nombre debe tener máximo 60 caracteres' });
  } else {
    const validacionCodigo = validarSinCodigoMalicioso(datos.nombre);
    if (!validacionCodigo.valido) {
      errores.push({ campo: 'nombre', mensaje: validacionCodigo.error });
    }
  }

  // Apellidos: requerido, 2-60 chars
  if (!datos.apellidos || typeof datos.apellidos !== 'string' || datos.apellidos.trim().length < 2) {
    errores.push({ campo: 'apellidos', mensaje: 'Los apellidos son obligatorios (mínimo 2 caracteres)' });
  } else if (datos.apellidos.trim().length > 60) {
    errores.push({ campo: 'apellidos', mensaje: 'Los apellidos deben tener máximo 60 caracteres' });
  } else {
    const validacionCodigo = validarSinCodigoMalicioso(datos.apellidos);
    if (!validacionCodigo.valido) {
      errores.push({ campo: 'apellidos', mensaje: validacionCodigo.error });
    }
  }

  // Telefono: OBLIGATORIO
  if (datos.telefono === undefined || datos.telefono === null || String(datos.telefono).trim() === '') {
    errores.push({ campo: 'telefono', mensaje: 'El teléfono es obligatorio' });
  } else {
    const validacionTelefono = validarTelefono(datos.telefono);
    if (!validacionTelefono.valido) {
      errores.push({ campo: 'telefono', mensaje: validacionTelefono.error });
    }
  }

  // DNI: OBLIGATORIO. Texto de solo dígitos (admite ceros a la izquierda), 8 a 15.
  const dni = String(datos.dni ?? '').trim();
  if (!dni) {
    errores.push({ campo: 'dni', mensaje: 'El DNI es obligatorio' });
  } else if (!/^[0-9]{8,15}$/.test(dni)) {
    errores.push({ campo: 'dni', mensaje: 'El DNI debe tener entre 8 y 15 dígitos' });
  }

  return { valido: errores.length === 0, errores };
}

/**
 * Valida datos de restablecimiento de contraseña.
 *
 * @param {Object} datos - { token, nuevaPassword, confirmarPassword }
 * @returns {Object} { valido: boolean, errores: Array }
 */
function validarRestablecimiento(datos) {
  const errores = [];

  if (!datos.token || typeof datos.token !== 'string' || datos.token.trim().length === 0) {
    errores.push({ campo: 'token', mensaje: 'Token de recuperacion es requerido' });
  }

  if (!datos.nuevaPassword || typeof datos.nuevaPassword !== 'string') {
    errores.push({ campo: 'nuevaPassword', mensaje: 'Nueva contrasena es requerida' });
  } else {
    if (datos.nuevaPassword.length < 8) {
      errores.push({ campo: 'nuevaPassword', mensaje: 'Contrasena debe tener minimo 8 caracteres' });
    }
    if (!/[A-Z]/.test(datos.nuevaPassword)) {
      errores.push({ campo: 'nuevaPassword', mensaje: 'Contrasena debe contener al menos una letra mayuscula' });
    }
    if (!/[a-z]/.test(datos.nuevaPassword)) {
      errores.push({ campo: 'nuevaPassword', mensaje: 'Contrasena debe contener al menos una letra minuscula' });
    }
    if (!/[0-9]/.test(datos.nuevaPassword)) {
      errores.push({ campo: 'nuevaPassword', mensaje: 'Contrasena debe contener al menos un numero' });
    }
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(datos.nuevaPassword)) {
      errores.push({ campo: 'nuevaPassword', mensaje: 'Contrasena debe contener al menos un caracter especial' });
    }
  }

  if (datos.nuevaPassword !== datos.confirmarPassword) {
    errores.push({ campo: 'confirmarPassword', mensaje: 'Las contrasenas no coinciden' });
  }

  return { valido: errores.length === 0, errores };
}

module.exports = {
  validarProducto,
  validarCliente,
  validarCotizacion,
  validarEstadoCotizacion,
  validarMargen,
  validarId,
  validarCodigoTicket,
  validarCredenciales,
  validarRegistro,
  validarRestablecimiento
};
