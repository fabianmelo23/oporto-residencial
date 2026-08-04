# Informe de seguridad — Oporto Residencial

**Fecha:** 4 de agosto de 2026  
**Alcance:** aplicación Node/Express + frontend vanilla JS + persistencia JSON (sin SQL)  
**Entorno de referencia:** demo en Railway + código en GitHub

---

## Resumen ejecutivo

La aplicación **no usa base de datos SQL**, por lo que **inyección SQL no aplica**. El riesgo principal está en: sesiones sin caducidad (corregido en este ciclo), fuerza bruta de login (mitigado), XSS almacenado en pantallas HTML, credenciales de demostración públicas, y endurecimiento de cabeceras/CORS.

**Postura actual (tras los cambios de este informe):** adecuada para un **portal de demostración**. Para producción con datos reales de residentes se recomienda completar el plan de remediación de la sección final (rotar credenciales demo, CSP, validación estricta de imágenes, CSRF).

| Nivel | Estado |
|-------|--------|
| Crítico abierto | Credenciales demo publicadas (intencional en demo) |
| Alto | Parcialmente mitigado (sesión, rate limit, XSS parcial, headers) |
| Medio / Bajo | Documentados; varios pendientes |

---

## Qué ya está bien

| Control | Detalle |
|---------|---------|
| Hash de contraseñas | `scrypt` + salt aleatorio + `timingSafeEqual` |
| Tokens de sesión | `crypto.randomBytes(32)` |
| Cookie de sesión | `HttpOnly`, `SameSite=Lax`, `Secure` en producción/Railway, `Max-Age` |
| Autorización por rol | `requireAuth` / `requireSuperAdmin` en APIs |
| Alcance por unidad | Residentes no pueden crear visitas/reservas/mantenimiento de otra unidad |
| Firmas | Staff no puede leer firmas de visitas/correspondencia |
| Respuestas API | `passwordHash` se elimina en respuestas públicas |
| Sin shell/eval | No hay `child_process` ni `eval` |
| Sin path traversal HTTP | Ruta del JSON solo por variables de entorno / volume |
| Persistencia Railway | Volume en `/data` (no efímero) |

---

## Hallazgos y estado

### 1. Sesión sin caducidad — **Corregido**
Antes la sesión vivía hasta logout o reinicio del servidor.  
**Ahora:**
- Inactividad: **60 minutos** (`SESSION_IDLE_MINUTES`)
- Máximo absoluto: **12 horas** (`SESSION_ABSOLUTE_HOURS`)
- El cliente vuelve al login si recibe `401` / `SESSION_EXPIRED`
- Cambio/reset de contraseña o baja de usuario invalida sesiones

### 2. Fuerza bruta en login — **Mitigado**
Límite: **8 intentos fallidos** por IP+usuario en **15 minutos** → HTTP `429`.  
Configurable: `LOGIN_MAX_ATTEMPTS`, `LOGIN_WINDOW_MINUTES`.

### 3. Credenciales de demostración públicas — **Aceptado en demo / Riesgo crítico en producción**
Están en la pantalla de login, README y manual (`administracionoporto`, vigilantes, etc.).  
Útil para la demo con la administradora; **antes de datos reales hay que rotar todas las claves y quitarlas de la UI pública**.

### 4. XSS almacenado — **Parcialmente corregido**
Había campos renderizados con `innerHTML` sin escapar (mantenimiento, pagos, reservas, búsqueda).  
Se escaparon los más expuestos. Queda revisar el resto de plantillas y añadir CSP.

### 5. CORS abierto — **Mitigado (configurable)**
Por defecto sigue permitiendo orígenes (demo). En producción definir:
`CORS_ORIGINS=https://tu-dominio.railway.app`

### 6. Cabeceras de seguridad — **Mejorado**
Añadidos: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `COOP`, `HSTS` en producción. Aún falta Content-Security-Policy afinada.

### 7. `/health` filtraba rutas internas — **Mitigado**
Público: solo `status` / `service`.  
Detalle de DB (`dbPath`, volume): solo con `?detail=1` y sesión **admin**.

### 8. Inyección SQL — **No aplica**
Almacenamiento en archivo JSON. No hay consultas SQL que explotar.

### 9. Otros vectores revisados

| Vector | Evaluación |
|--------|------------|
| SQL Injection | N/A (JSON file DB) |
| Command injection | No encontrado |
| Path traversal vía request | No encontrado |
| Prototype pollution | Riesgo bajo (no se hace merge profundo de `req.body` a Object.prototype) |
| CSRF | Riesgo medio (cookie + SameSite=Lax ayuda; falta token CSRF) |
| IDOR entre unidades | En general bien acotado; calendario de reservas muestra ocupación de otras unidades (diseño) |
| Tokens en query (`/api/events`, media) | Riesgo medio (pueden filtrarse en logs/historial) |
| Subida base64 (fotos/firmas) | Riesgo medio (límite 10 MB JSON; validación MIME incompleta) |
| Staff fuera de turno | Login de staff abierto en demo (`ENFORCE_STAFF_DUTY=false`) |
| DoS por scrypt en login | Mitigado en parte con rate limit |

---

## Cómo se almacenan los datos (privacidad)

- Archivo JSON en disco / volume Railway (`/data/database.json`).
- Incluye PII: nombres, unidades, teléfonos, correos, visitas, firmas (base64), fotos de correspondencia/mascotas.
- Las firmas y fotos sensibles no se listan completas en JSON de listados; se sirven por endpoints con auth.
- **No** se sincronizan datos operativos de Railway hacia GitHub (política del proyecto).

---

## Variables de entorno de seguridad

| Variable | Default | Uso |
|----------|---------|-----|
| `SESSION_IDLE_MINUTES` | `60` | Caducidad por inactividad |
| `SESSION_ABSOLUTE_HOURS` | `12` | Caducidad máxima |
| `LOGIN_MAX_ATTEMPTS` | `8` | Intentos fallidos de login |
| `LOGIN_WINDOW_MINUTES` | `15` | Ventana del rate limit |
| `CORS_ORIGINS` | (vacío = permitir) | Lista de orígenes permitidos |
| `COOKIE_SECURE` | auto en Railway | Fuerza cookie `Secure` |
| `ENFORCE_STAFF_DUTY` | `false` | Solo vigilantes en turno pueden entrar |
| `FORCE_SECURE_HEADERS` | — | Activa HSTS fuera de production |

---

## Plan recomendado antes de producción real

1. Rotar **todas** las contraseñas demo y quitarlas del HTML público.  
2. Activar `ENFORCE_STAFF_DUTY=true`.  
3. Definir `CORS_ORIGINS` al dominio real.  
4. Completar escape XSS en todas las vistas + CSP.  
5. Validar magic bytes / tamaño máximo de imágenes y firmas; rechazar SVG.  
6. Tokens de descarga de corta vida (evitar token en query string).  
7. Copias de seguridad cifradas del volume y acceso admin solo por HTTPS.  
8. Considerar 2FA para cuentas admin.

---

## Pruebas realizadas en este ciclo

- Suite automatizada `npm test` (incluye caducidad de sesión y rate limit de login).
- Revisión estática de `src/auth.js`, `src/app.js`, `src/store.js`, `public/app.js`, seed y docs.
