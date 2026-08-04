/**
 * Zona horaria operativa del conjunto residencial (Colombia).
 * Debe cargarse antes de cualquier lógica de turnos/fechas locales.
 * En Railway el host suele ser UTC; sin esto, 13:30 Bogotá se lee como
 * fuera del diurno (07:00–18:00) y aparece el vigilante del nocturno.
 */
process.env.TZ = 'America/Bogota';

module.exports = {
  APP_TIMEZONE: 'America/Bogota',
};
