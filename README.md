# Oporto Residencial

Plataforma de gestión para conjuntos residenciales. Permite administrar residentes, visitas, reservas, mantenimiento, pagos, anuncios, personal de seguridad, correspondencia y turnos de vigilancia.

## Configuración local (primera vez)

```bash
npm run setup
```

Esto instala dependencias y crea `.env` si no existe. Luego:

```bash
npm run dev
```

Abre en el navegador: **http://localhost:3000**

## Desarrollo en Cursor / VS Code

| Acción | Cómo |
|--------|------|
| Servidor con recarga automática | Terminal → `npm run dev` |
| Depurar con breakpoints | Run and Debug → **Oporto: depurar servidor** |
| Ejecutar pruebas | Terminal → `npm test` o tarea **Oporto: ejecutar pruebas** |

Los datos de trabajo se guardan en `data/database.local.json` (no se versiona). La semilla inicial está en `data/database.json`.

> **Importante:** no subas tu `database.local.json` a GitHub. Ese archivo es solo local. Los cambios operativos (residentes, visitas, etc.) se quedan en tu máquina / Railway y **no deben sincronizarse al repo**. El agente tampoco debe copiar datos locales a GitHub de aquí en adelante.

## Producción local

```bash
npm start
```

## Pruebas

```bash
npm test
```

## Usuarios de prueba

| Rol | Usuario | Contraseña |
|-----|---------|------------|
| Super Admin (desarrollador) | `admin` | `Jandrey26+` |
| Administración | `administracionoporto` | `oporto123` |
| Vigilante | `f.melo` | `melo123` |
| Vigilante | `y.obando` | `obando123` |
| Vigilante | `j.bernal` | `bernal123` |
| Residente | `Pepito201` | `Pepito201` |

## Variables de entorno (`.env`)

| Variable        | Valor por defecto              | Descripción                    |
|-----------------|--------------------------------|--------------------------------|
| `PORT`          | `3000`                         | Puerto del servidor            |
| `DATABASE_FILE` | `./data/database.local.json`   | Archivo JSON de persistencia   |

### Railway (importante)

En Railway el disco del contenedor es **efímero**: cada deploy borra los datos operativos si no hay volumen.

1. En el servicio, crea un **Volume** con mount path `/data`.
2. Define la variable `DATABASE_FILE=/data/database.json`.
3. Redesplegar. A partir de ahí residentes, visitas, reservas, etc. sobreviven a los deploys.

Si existe `RAILWAY_VOLUME_MOUNT_PATH`, la app también usará automáticamente `database.json` dentro de ese volumen.
