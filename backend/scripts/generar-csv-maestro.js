'use strict';

const fs = require('fs');
const path = require('path');
const { parsearCSV, normalizarFilasParaCSV } = require('../src/servicios/servicioImportacion');

const ENTRADA = path.resolve(__dirname, '..', 'assets', 'DCW_20260407094705.csv');
const SALIDA = path.resolve(__dirname, '..', 'assets', 'DCW_20260407094705_estructurado.csv');

function escaparCSV(valor) {
  const texto = String(valor ?? '');
  if (texto.includes(',') || texto.includes('"') || texto.includes('\n')) {
    return `"${texto.replace(/"/g, '""')}"`;
  }
  return texto;
}

function main() {
  const buffer = fs.readFileSync(ENTRADA);
  const filas = parsearCSV(buffer);
  const normalizadas = normalizarFilasParaCSV(filas);

  const columnas = [
    'categoria',
    'subcategoria',
    'categoria_proveedor',
    'codigo_proveedor',
    'marca',
    'nombre',
    'descripcion_general',
    'stock',
    'disponible_a_pedido',
    'precio_base',
    'garantia',
    'flete',
    'socket',
    'cpu_nucleos',
    'cpu_hilos',
    'cpu_frecuencia_base_ghz',
    'cpu_frecuencia_boost_ghz',
    'cpu_tdp_w',
    'cpu_graficos_integrados',
    'mb_chipset',
    'mb_form_factor',
    'mb_ram_tipo',
    'mb_max_ram_gb',
    'mb_m2_slots',
    'mb_pcie_version',
    'ram_tipo',
    'ram_capacidad_gb',
    'ram_velocidad_mhz',
    'ram_cantidad_modulos',
    'storage_tipo',
    'storage_capacidad_gb',
    'storage_interfaz',
    'storage_form_factor',
    'storage_nvme_gen',
    'gpu_chipset',
    'gpu_vram_gb',
    'gpu_vram_tipo',
    'gpu_tdp_w',
    'gpu_longitud_mm',
    'psu_wattage',
    'psu_certificacion',
    'psu_modular',
    'psu_form_factor',
    'case_form_factor',
    'case_color',
    'case_max_gpu_mm',
    'case_compatibilidad_placa',
  ];

  const lineas = [columnas.join(',')];
  for (const fila of normalizadas) {
    fila.flete = '';
    lineas.push(columnas.map((col) => escaparCSV(fila[col])).join(','));
  }

  fs.writeFileSync(SALIDA, `${lineas.join('\n')}\n`, 'utf8');
  console.log(`CSV generado: ${SALIDA}`);
  console.log(`Filas exportadas: ${normalizadas.length}`);
}

main();
