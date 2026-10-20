# Supabase Auth: guía de configuración

SmartDJ usa Supabase Auth para el registro, la verificación del correo, el inicio de sesión y la recuperación de contraseña. Supabase envía los códigos de 6 dígitos con un SMTP de Gmail; la API solo valida los tokens.

## Cómo funciona

| Paso | Qué pasa |
| --- | --- |
| Registro | El frontend llama a `signUp` con el correo, la contraseña y el nombre en `user_metadata`. Supabase envía un **código de 6 dígitos**; la persona lo escribe y el frontend llama a `verifyOtp` con `type: 'email'`. |
| Reenviar código | `resend({ type: 'signup' })`, con 60 s de espera entre correos. |
| Login | `signInWithPassword`. El frontend manda el access token como `Bearer` a la API. |
| Perfil local | En la primera petición con un token válido y el correo confirmado, la API crea la fila en `users` con `auth_id`. Los locales (`establishments.owner_id`) apuntan a ese `users.id`. |
| Recuperar contraseña | `resetPasswordForEmail` envía un código; la persona lo escribe junto con la contraseña nueva (`verifyOtp` con `type: 'recovery'` y luego `updateUser`). Al terminar se cierran todas las sesiones. |

## 1. Proveedor de correo

**Authentication → Sign In / Providers → Email:**

1. **Enable Email provider**: activado.
2. **Confirm email**: activado. Sin confirmar el correo no se puede iniciar sesión.
3. **Email OTP Length**: `6`.
4. **Email OTP Expiration**: `600` (10 minutos, lo que dice la app).
5. **Minimum interval between emails per user**: `60` segundos (lo mismo que espera el botón "Reenviar código").
6. **Password requirements**: mínimo `8` caracteres, con letras y números.

## 2. SMTP propio con Gmail

El correo integrado de Supabase solo envía a los miembros del proyecto, así que hace falta un SMTP propio. Supabase sí puede usar los puertos SMTP (Render Free no).

1. En tu cuenta de Google activa la **Verificación en 2 pasos** y crea una **contraseña de aplicación** en https://myaccount.google.com/apppasswords. Copia las 16 letras sin espacios.
2. En **Authentication → Emails → SMTP Settings**, activa **Enable Custom SMTP**:

   | Campo | Valor |
   | --- | --- |
   | Sender email | tu correo de Gmail |
   | Sender name | `SmartDJ` |
   | Host | `smtp.gmail.com` |
   | Port number | `465` |
   | Username | tu correo de Gmail completo |
   | Password | la contraseña de aplicación de 16 letras |

## 3. Plantillas en español

En **Authentication → Emails → Templates**. Las dos usan `{{ .Token }}` (el código), **no** `{{ .ConfirmationURL }}`: la app solo trabaja con códigos.

### Confirm signup

**Subject:** `Tu código para activar SmartDJ`

```html
<h2>Activa tu cuenta</h2>
<p>Hola:</p>
<p>Gracias por registrarte en SmartDJ. Escribe este código en la app para confirmar tu correo:</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px;">{{ .Token }}</p>
<p>El código vence en 10 minutos y solo se puede usar una vez.</p>
<p>Si no creaste esta cuenta, ignora este mensaje.</p>
<p>Equipo de SmartDJ</p>
```

### Reset password

**Subject:** `Tu código para cambiar la contraseña de SmartDJ`

```html
<h2>Cambia tu contraseña</h2>
<p>Hola:</p>
<p>Recibimos una solicitud para cambiar la contraseña de tu cuenta de SmartDJ. Escribe este código en la app:</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px;">{{ .Token }}</p>
<p>El código vence en 10 minutos y solo se puede usar una vez.</p>
<p>Si no fuiste tú, ignora este mensaje: tu contraseña no cambiará.</p>
<p>Equipo de SmartDJ</p>
```

## 4. URL Configuration

**Authentication → URL Configuration:**

- **Site URL:** la URL de Vercel.
- **Redirect URLs:** la URL de Vercel con `/**` y `http://localhost:5173/**`.

## 5. Límites

**Authentication → Rate Limits:**

- **Rate limit for sending emails:** `30` por hora (con SMTP propio).
- **Rate limit for token verifications:** el valor por defecto. Es el límite de intentos para escribir el código; después Supabase responde 429 y la app muestra "Hiciste demasiados intentos".

## 6. Claves para validar los tokens

En **Project Settings → JWT Keys**, usa claves asimétricas (**ECC P-256** o **RSA**). La API las lee de `SUPABASE_JWKS_URL`, que no es un secreto. Si el proyecto sigue con el **Legacy JWT Secret** (HS256), pon ese valor en `SUPABASE_JWT_SECRET`, solo en Render.

## 7. Variables

**Render (backend):** `SUPABASE_URL`, `SUPABASE_JWKS_URL` y, solo si usas HS256, `SUPABASE_JWT_SECRET`.

**Vercel (frontend):** ninguna. La URL del proyecto y la clave **anon/publishable** van en `config.js` del frontend (son públicas por diseño). Nunca uses la `service_role`.

## 8. Base de datos

En el SQL Editor ejecuta, en orden, `database/migrations/001_verificacion_por_codigo.sql` (si no lo hiciste) y `database/migrations/002_supabase_auth.sql`.
