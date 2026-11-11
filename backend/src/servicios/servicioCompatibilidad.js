/**
 * Servicio de Compatibilidad de Componentes.
 *
 * Valida que los componentes de un armado de PC sean compatibles entre sí
 * (socket CPU/placa, tipo de RAM, factor de forma, espacio físico de la GPU,
 * potencia de la fuente y disponibilidad de stock).
 *
 * La fuente de verdad son las tablas specs_* en la base de datos. Expone dos
 * caminos de validación:
 *   - validarConfiguracion:        validación en memoria con los datos recibidos.
 *   - validarConfiguracionConBD:   validación autoritativa leyendo specs reales de la BD.
 */
class ServicioCompatibilidad {
  /**
   * Normaliza un texto de factor de forma a un valor canónico en mayúsculas
   * (MINI-ITX, MICRO-ATX, E-ATX o ATX). Devuelve el valor original en mayúsculas
   * si no reconoce el patrón, o null si el valor está vacío.
   */
  normalizarFormFactor(valor) {
    if (!valor) return null;
    const texto = String(valor).toLowerCase().replace(/\s+/g, '').replace('_', '-');

    if (texto.includes('mini-itx') || texto === 'itx') return 'MINI-ITX';
    if (texto.includes('micro-atx') || texto.includes('matx')) return 'MICRO-ATX';
    if (texto.includes('e-atx') || texto.includes('eatx')) return 'E-ATX';
    if (texto.includes('atx')) return 'ATX';

    return String(valor).toUpperCase();
  }

  /**
   * Separa una lista de factores de forma (delimitada por ; , / o |),
   * normaliza cada elemento y elimina duplicados.
   * @returns {string[]} Factores de forma canónicos y únicos.
   */
  parsearListaFormFactor(valor) {
    if (!valor) return [];
    const texto = String(valor).split(/[;,/|]/).map((x) => this.normalizarFormFactor(x)).filter(Boolean);
    return [...new Set(texto)];
  }

  /**
   * Deduce los factores de forma que soporta un gabinete a partir de su
   * descripción técnica en texto libre. Aplica compatibilidad descendente:
   * un gabinete que admite ATX también admite Micro-ATX y Mini-ITX.
   * Si no detecta ninguno, asume soporte para los tres tamaños estándar.
   */
  parsearFormFactors(descripcion) {
    const ff = [];
    const desc = String(descripcion || '').toLowerCase();

    if (desc.includes('mini-itx')) ff.push('Mini-ITX');
    if (desc.includes('micro-atx') || desc.includes('matx')) ff.push('Micro-ATX');
    if (desc.includes('e-atx') || desc.includes('eatx')) ff.push('E-ATX');
    if (/(?:^|\s|case\s)atx(?:\s|$|,|\/)/.test(desc)) ff.push('ATX');

    if (ff.includes('ATX')) {
      if (!ff.includes('Micro-ATX')) ff.push('Micro-ATX');
      if (!ff.includes('Mini-ITX')) ff.push('Mini-ITX');
    }

    return ff.length > 0 ? ff : ['ATX', 'Micro-ATX', 'Mini-ITX'];
  }

  /** Filtra la lista de placas madre dejando solo las que coinciden con el socket del procesador. */
  filtrarPlacasPorSocket(placasMadre, socketProcesador) {
    if (!socketProcesador) return placasMadre;
    return placasMadre.filter((placa) => placa.socket === socketProcesador);
  }

  /** Verifica que el socket del procesador y el de la placa coincidan. True si falta alguno de los dos. */
  validarSocket(procesador, placaMadre) {
    if (!procesador || !placaMadre) return true;
    return procesador.socket === placaMadre.socket;
  }

  /** Verifica que el tipo de RAM (DDR4/DDR5) de los módulos coincida con el que soporta la placa. */
  validarTipoRAM(placaMadre, modulosRAM) {
    if (!placaMadre || !modulosRAM || modulosRAM.length === 0) return true;
    const tipoRAM = modulosRAM[0].ram_type || modulosRAM[0].ram_tipo;
    return (placaMadre.ram_type || placaMadre.ram_tipo) === tipoRAM;
  }

  /** Verifica que el factor de forma de la placa esté entre los que soporta el gabinete. */
  validarFormFactor(placaMadre, caseGabinete) {
    if (!placaMadre || !caseGabinete) return true;
    const soportados = this
      .parsearFormFactors(caseGabinete.descripcion_tecnica || caseGabinete.compatibilidad_placa)
      .map((ff) => this.normalizarFormFactor(ff));
    return soportados.includes(this.normalizarFormFactor(placaMadre.form_factor));
  }

  /**
   * Obtiene el wattaje de una fuente. Usa el campo numérico `wattage` si existe;
   * en su defecto lo extrae por expresión regular del nombre/descripción (ej. "650W").
   * @returns {number} Wattaje detectado, o 0 si no se pudo determinar.
   */
  extraerPotenciaFuente(fuente) {
    if (!fuente) return 0;
    if (typeof fuente.wattage === 'number' && fuente.wattage > 0) return fuente.wattage;

    const texto = String((fuente.nombre || '') + ' ' + (fuente.descripcion_tecnica || '')).toLowerCase();
    const match = texto.match(/(\d{3,4})\s*w/);
    if (match) return parseInt(match[1], 10);
    return 0;
  }

  /**
   * Estima el consumo eléctrico total del armado en vatios.
   * Suma el TDP real de CPU y GPU, más estimaciones para placa (35W si no hay dato),
   * RAM (4W por módulo), almacenamiento (6W por unidad) y base del sistema (20W).
   * Aplica un margen de seguridad del 25% (×1.25) sobre el subtotal.
   * @returns {number} Consumo estimado en vatios, redondeado hacia arriba.
   */
  calcularConsumoTotal(componentes) {
    const cpuTdp = Number(componentes.procesador?.tdp_w ?? componentes.procesador?.tdp ?? 0) || 0;
    const gpuTdp = Number(componentes.gpu?.tdp_w ?? componentes.gpu?.tdp ?? 0) || 0;

    const placaReal = Number(componentes.placa_madre?.tdp_w ?? 0);
    const placaEstimado = placaReal > 0 ? placaReal : 35;

    const ramModulos = Array.isArray(componentes.ram) ? componentes.ram.length : 0;
    const ramTotal = ramModulos * 4;

    const storage = Array.isArray(componentes.almacenamiento)
      ? componentes.almacenamiento.length * 6
      : (componentes.almacenamiento ? 6 : 0);

    const baseSistema = 20;
    const subtotal = cpuTdp + gpuTdp + placaEstimado + ramTotal + storage + baseSistema;
    return Math.ceil(subtotal * 1.25);
  }

  /**
   * Compara el consumo estimado del armado contra el wattaje de la fuente.
   * Se considera suficiente si la fuente cubre el consumo, o si no se pudo
   * determinar su wattaje (0, para no bloquear el armado por falta de dato).
   * @returns {{suficiente: boolean, consumoTotal: number, wattajeFuente: number}}
   */
  validarPotencia(componentes) {
    if (!componentes.fuente) {
      return { suficiente: true, consumoTotal: this.calcularConsumoTotal(componentes), wattajeFuente: 0 };
    }

    const consumoTotal = this.calcularConsumoTotal(componentes);
    let wattajeFuente = Number(componentes.fuente.wattage || 0);

    if (!wattajeFuente || wattajeFuente <= 0) {
      wattajeFuente = this.extraerPotenciaFuente(componentes.fuente);
    }

    return {
      suficiente: wattajeFuente >= consumoTotal || wattajeFuente === 0,
      consumoTotal,
      wattajeFuente,
    };
  }

  /** Devuelve los componentes sin stock pero marcados como disponibles a pedido. */
  identificarComponentesAPedido(componentes) {
    const aPedido = [];

    for (const comp of Object.values(componentes)) {
      if (Array.isArray(comp)) {
        aPedido.push(...comp.filter((c) => c.stock === 0 && c.disponible_a_pedido));
      } else if (comp?.stock === 0 && comp?.disponible_a_pedido) {
        aPedido.push(comp);
      }
    }

    return aPedido;
  }

  /** Verifica que el largo de la GPU (mm) no exceda el máximo admitido por el gabinete. */
  verificarEspacioFisico(gpu, caseGabinete) {
    if (!gpu || !caseGabinete) return { ok: true };
    const largoGpu = Number(gpu.longitud_mm || 0);
    const maxCase = Number(caseGabinete.max_gpu_mm || 0);
    if (largoGpu > 0 && maxCase > 0 && largoGpu > maxCase) {
      return {
        ok: false,
        mensaje: `Espacio fisico insuficiente: GPU ${largoGpu}mm excede maximo del case ${maxCase}mm`,
      };
    }
    return { ok: true };
  }

  /**
   * Si el armado no incluye GPU dedicada, exige que el procesador tenga gráficos
   * integrados; de lo contrario el sistema no tendría salida de video.
   */
  verificarGraficosIntegrados(cpu, gpu) {
    if (gpu) return { ok: true };
    if (!cpu) return { ok: true };

    if (cpu.graficos_integrados === null || cpu.graficos_integrados === undefined || cpu.graficos_integrados === '') {
      return { ok: true };
    }
    const tieneGraficos = cpu.graficos_integrados === true || cpu.graficos_integrados === 'true';
    if (!tieneGraficos) {
      return {
        ok: false,
        mensaje: 'El sistema requiere una tarjeta de video dedicada o un procesador con graficos integrados.',
      };
    }
    return { ok: true };
  }

  /**
   * Validación en memoria del armado usando los datos ya presentes en `componentes`
   * (sin consultar la BD). Reúne incompatibilidades bloqueantes en `errores` y
   * situaciones no bloqueantes en `advertencias`.
   * @returns {{compatible: boolean, errores: string[], advertencias: string[]}}
   */
  validarConfiguracion(componentes) {
    const errores = [];
    const advertencias = [];

    if (componentes.procesador && componentes.placa_madre) {
      if ((componentes.procesador.socket || null) !== (componentes.placa_madre.socket || null)) {
        errores.push(`Socket incompatible: ${componentes.procesador.socket} vs ${componentes.placa_madre.socket}`);
      }
    }

    if (componentes.placa_madre && componentes.ram?.length > 0) {
      const tipoRAM = componentes.ram[0].ram_type || componentes.ram[0].ram_tipo;
      const tipoPlaca = componentes.placa_madre.ram_type || componentes.placa_madre.ram_tipo;
      if (tipoPlaca && tipoRAM && tipoPlaca !== tipoRAM) {
        errores.push(`RAM incompatible: Placa soporta ${tipoPlaca}, seleccionado ${tipoRAM}`);
      }
    }

    if (componentes.placa_madre && componentes.case) {
      const soportados = this
        .parsearFormFactors(componentes.case.descripcion_tecnica || componentes.case.compatibilidad_placa)
        .map((ff) => this.normalizarFormFactor(ff));
      const formFactorPlaca = this.normalizarFormFactor(componentes.placa_madre.form_factor);
      if (formFactorPlaca && !soportados.includes(formFactorPlaca)) {
        errores.push(`Case no soporta el factor de forma ${formFactorPlaca}`);
      }
    }

    const espacio = this.verificarEspacioFisico(componentes.gpu, componentes.case);
    if (!espacio.ok) errores.push(espacio.mensaje);

    const video = this.verificarGraficosIntegrados(componentes.procesador, componentes.gpu);
    if (!video.ok) errores.push(video.mensaje);

    const potencia = this.validarPotencia(componentes);
    if (potencia.wattajeFuente > 0) {
      if (!potencia.suficiente) {
        errores.push(`Fuente insuficiente: requiere ${potencia.consumoTotal}W, tiene ${potencia.wattajeFuente}W`);
      } else if (potencia.wattajeFuente < Math.ceil(potencia.consumoTotal * 1.1)) {
        advertencias.push(`La fuente esta muy justa, se recomienda una mayor (recomendado: ${Math.ceil(potencia.consumoTotal * 1.1)}W).`);
      }
    } else {
      advertencias.push(`No se detecto la potencia exacta de la fuente. Consumo estimado: ${potencia.consumoTotal}W.`);
    }

    const aPedido = this.identificarComponentesAPedido(componentes);
    if (aPedido.length > 0) {
      advertencias.push(`Componentes a pedido detectados: ${aPedido.length}.`);
    }

    return { compatible: errores.length === 0, errores, advertencias };
  }

  /**
   * Consulta las especificaciones técnicas (tablas specs_*) de los productos indicados
   * y las devuelve indexadas por id para acceso O(1). Deduplica y filtra ids no enteros.
   * @param {Array} ids - Ids de producto a consultar.
   * @param {Function} ejecutarQuery - Helper de acceso a BD inyectado.
   * @returns {Promise<Map<number, object>>} Mapa id -> fila con specs unificadas.
   */
  async obtenerMapaSpecsPorIds(ids, ejecutarQuery) {
    const idsUnicos = [...new Set(
      (Array.isArray(ids) ? ids : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id))
    )];
    if (idsUnicos.length === 0) return new Map();

    const resultado = await ejecutarQuery(
      `SELECT
         p.id,
         c.nombre AS categoria,
         p.subcategoria,
         p.nombre,
         p.stock,
         p.disponible_a_pedido,
         sp.socket AS cpu_socket,
         sp.tdp_w AS cpu_tdp_w,
         sp.graficos_integrados,
         sm.socket AS mb_socket,
         sm.ram_tipo AS mb_ram_tipo,
         sm.form_factor AS mb_form_factor,
         sm.m2_slots,
         sm.pcie_version,
         sr.ram_tipo,
         sa.tipo_almacenamiento,
         sg.tdp_w AS gpu_tdp_w,
         sg.longitud_mm,
         sg.fuente_recomendada_w,
         sf.wattage,
         sc.max_gpu_mm,
         sc.compatibilidad_placa,
         sc.form_factor AS case_form_factor
       FROM productos p
       INNER JOIN categorias c ON c.id = p.id_categoria
       LEFT JOIN specs_procesador sp ON sp.id_producto = p.id
       LEFT JOIN specs_placa_madre sm ON sm.id_producto = p.id
       LEFT JOIN specs_ram sr ON sr.id_producto = p.id
       LEFT JOIN specs_almacenamiento sa ON sa.id_producto = p.id
       LEFT JOIN specs_gpu sg ON sg.id_producto = p.id
       LEFT JOIN specs_fuente sf ON sf.id_producto = p.id
       LEFT JOIN specs_case sc ON sc.id_producto = p.id
       WHERE p.id = ANY($1::int[])`,
      [idsUnicos]
    );

    return new Map(resultado.rows.map((r) => [r.id, r]));
  }

  /** Recolecta los ids de todos los componentes del armado y obtiene sus specs desde la BD. */
  async obtenerMapaComponentesDesdeBD(componentes, ejecutarQuery) {
    const ids = [];
    const pushId = (comp) => {
      if (comp && Number.isInteger(Number(comp.id))) ids.push(Number(comp.id));
    };

    pushId(componentes.procesador);
    pushId(componentes.placa_madre);
    (componentes.ram || []).forEach(pushId);
    if (Array.isArray(componentes.almacenamiento)) componentes.almacenamiento.forEach(pushId);
    else pushId(componentes.almacenamiento);
    pushId(componentes.gpu);
    pushId(componentes.fuente);
    pushId(componentes.case);

    return this.obtenerMapaSpecsPorIds(ids, ejecutarQuery);
  }

  /**
   * Transforma una fila de specs de la BD al formato que esperan los validadores,
   * seleccionando los campos relevantes según la categoría del componente.
   * @returns {object|null} Componente normalizado, o null si no hay fila para ese id.
   */
  convertirComponenteBD(comp, mapa) {
    if (!comp || !comp.id) return null;
    const row = mapa.get(Number(comp.id));
    if (!row) return null;

    const base = {
      id: row.id,
      nombre: row.nombre,
      categoria: row.categoria,
      stock: row.stock,
      disponible_a_pedido: row.disponible_a_pedido,
    };

    if (row.categoria === 'procesador') {
      return { ...base, socket: row.cpu_socket, tdp_w: row.cpu_tdp_w, graficos_integrados: row.graficos_integrados };
    }
    if (row.categoria === 'placa_madre') {
      return {
        ...base,
        socket: row.mb_socket,
        ram_tipo: row.mb_ram_tipo,
        form_factor: row.mb_form_factor,
        m2_slots: row.m2_slots,
        pcie_version: row.pcie_version,
      };
    }
    if (row.categoria === 'ram') {
      return { ...base, ram_tipo: row.ram_tipo };
    }
    if (row.categoria === 'almacenamiento') {
      return { ...base, tipo_almacenamiento: row.tipo_almacenamiento };
    }
    if (row.categoria === 'gpu') {
      return {
        ...base,
        tdp_w: row.gpu_tdp_w,
        longitud_mm: row.longitud_mm,
        fuente_recomendada_w: row.fuente_recomendada_w,
      };
    }
    if (row.categoria === 'fuente') {
      return { ...base, wattage: row.wattage };
    }
    if (row.categoria === 'case') {
      return {
        ...base,
        max_gpu_mm: row.max_gpu_mm,
        compatibilidad_placa: row.compatibilidad_placa,
        form_factor: row.case_form_factor,
      };
    }

    return base;
  }

  /**
   * Validación autoritativa del armado: lee las specs reales desde la BD (fuente de
   * verdad) en lugar de confiar en los datos del cliente. Verifica socket, tipo de RAM,
   * slots M.2, versión PCIe, gráficos integrados, potencia y espacio físico.
   * Si no encuentra specs en la BD, cae a la validación en memoria (validarConfiguracion).
   * @returns {Promise<{compatible: boolean, errores: string[], advertencias: string[]}>}
   */
  async validarConfiguracionConBD(componentes, ejecutarQuery) {
    const errores = [];
    const advertencias = [];

    const mapa = await this.obtenerMapaComponentesDesdeBD(componentes, ejecutarQuery);
    if (mapa.size === 0) {
      return this.validarConfiguracion(componentes);
    }
    const normalizados = {
      procesador: this.convertirComponenteBD(componentes.procesador, mapa),
      placa_madre: this.convertirComponenteBD(componentes.placa_madre, mapa),
      ram: (componentes.ram || []).map((r) => this.convertirComponenteBD(r, mapa)).filter(Boolean),
      almacenamiento: Array.isArray(componentes.almacenamiento)
        ? componentes.almacenamiento.map((a) => this.convertirComponenteBD(a, mapa)).filter(Boolean)
        : this.convertirComponenteBD(componentes.almacenamiento, mapa),
      gpu: this.convertirComponenteBD(componentes.gpu, mapa),
      fuente: this.convertirComponenteBD(componentes.fuente, mapa),
      case: this.convertirComponenteBD(componentes.case, mapa),
    };

    const requeridos = ['procesador', 'placa_madre', 'ram', 'almacenamiento', 'fuente', 'case'];
    requeridos.forEach(r => {
      if (!normalizados[r] || (Array.isArray(normalizados[r]) && normalizados[r].length === 0)) {
        errores.push(`Componente faltante o invalido: ${r}`);
      }
    });

    if (normalizados.procesador && normalizados.placa_madre) {
      if ((normalizados.procesador.socket || '') !== (normalizados.placa_madre.socket || '')) {
        errores.push(`Socket incompatible: ${normalizados.procesador.socket || 'N/D'} vs ${normalizados.placa_madre.socket || 'N/D'}`);
      }
    }

    if (normalizados.placa_madre && normalizados.ram.length > 0) {
      const tipoPlaca = normalizados.placa_madre.ram_tipo;
      const incompatibles = normalizados.ram.filter((r) => r.ram_tipo && tipoPlaca && r.ram_tipo !== tipoPlaca);
      if (incompatibles.length > 0) {
        errores.push(`RAM incompatible: Placa soporta ${tipoPlaca}, seleccionado ${incompatibles[0].ram_tipo}`);
      }
    }

    const almacenamiento = Array.isArray(normalizados.almacenamiento)
      ? normalizados.almacenamiento
      : (normalizados.almacenamiento ? [normalizados.almacenamiento] : []);

    const tieneM2 = almacenamiento.some((a) => /m\.2|nvme/i.test(String(a.tipo_almacenamiento || '')));
    if (tieneM2 && normalizados.placa_madre && Number(normalizados.placa_madre.m2_slots || 0) <= 0) {
      errores.push('Almacenamiento M.2 incompatible: la placa madre no tiene slots M.2 disponibles.');
    }

    if (normalizados.gpu && normalizados.placa_madre) {
      const pcie = String(normalizados.placa_madre.pcie_version || '').trim();
      if (pcie) {
        advertencias.push(`Compatibilidad PCIe: validar que GPU y placa operen en la mejor version disponible (${pcie}).`);
      }
    }

    const video = this.verificarGraficosIntegrados(normalizados.procesador, normalizados.gpu);
    if (!video.ok) errores.push(video.mensaje);

    if (normalizados.fuente) {
      const consumo = this.calcularConsumoTotal(normalizados);
      const wattage = Number(normalizados.fuente.wattage || 0);
      if (wattage > 0 && wattage < consumo) {
        errores.push(`Fuente insuficiente: requiere ${consumo}W, tiene ${wattage}W`);
      } else if (wattage > 0 && wattage < Math.ceil(consumo * 1.1)) {
        advertencias.push(`La fuente esta muy justa, se recomienda una mayor (recomendado: ${Math.ceil(consumo * 1.1)}W).`);
      }
    }

    if (normalizados.gpu && normalizados.case) {
      const espacio = this.verificarEspacioFisico(normalizados.gpu, normalizados.case);
      if (!espacio.ok) errores.push(espacio.mensaje);

      const ffPlaca = this.normalizarFormFactor(normalizados.placa_madre?.form_factor);
      const compatCase = this.parsearListaFormFactor(normalizados.case.compatibilidad_placa);
      if (ffPlaca && compatCase.length > 0 && !compatCase.includes(ffPlaca)) {
        errores.push(`Case no soporta el factor de forma ${ffPlaca}`);
      }
    }

    const aPedido = this.identificarComponentesAPedido(normalizados);
    if (aPedido.length > 0) advertencias.push(`Componentes a pedido detectados: ${aPedido.length}.`);

    return { compatible: errores.length === 0, errores, advertencias };
  }
}

module.exports = new ServicioCompatibilidad();
