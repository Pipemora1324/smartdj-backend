import crypto from 'crypto';
import { withTransaction } from './db.js';
import { config } from './config.js';
import { AppError } from './errors.js';
import { sendAuthCode } from './mailer.js';

export const CODE_TTL_MINUTES = 10;
export const RESEND_COOLDOWN_SECONDS = 60;
export const MAX_ATTEMPTS = 5;

// HMAC con secreto del servidor: con solo 1.000.000 de combinaciones, un hash
// simple se revertiría por fuerza bruta si se filtrara la base de datos.
const hashCode = (code) => crypto.createHmac('sha256', config.authCodeSecret).update(code).digest();

// Genera y envía un código nuevo. Si el último se pidió hace menos de 60 s,
// devuelve { cooldown } con los segundos que faltan y no envía nada.
export async function issueCode(user, purpose) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const cooldown = await withTransaction(async (client) => {
    // Bloquea al usuario para que dos peticiones simultáneas no salten la espera.
    await client.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    const last = await client.query(
      'SELECT EXTRACT(EPOCH FROM (NOW()-created_at)) AS age FROM auth_codes WHERE user_id=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1',
      [user.id, purpose]);
    const age = last.rowCount ? Number(last.rows[0].age) : Infinity;
    if (age < RESEND_COOLDOWN_SECONDS) return Math.ceil(RESEND_COOLDOWN_SECONDS - age);
    await client.query('UPDATE auth_codes SET used_at=NOW() WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL', [user.id, purpose]);
    await client.query(
      `INSERT INTO auth_codes(user_id,purpose,code_hash,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '${CODE_TTL_MINUTES} minutes')`,
      [user.id, purpose, hashCode(code).toString('hex')]);
    return 0;
  });
  if (cooldown) return { cooldown };
  await sendAuthCode(user.email, code, purpose);
  return { sent: true };
}

// Valida y consume el código dentro de la transacción del llamador.
// Devuelve null si es correcto o un AppError si no. No lanza el error para que
// el llamador haga COMMIT del intento fallido antes de responder.
export async function consumeCode(client, userId, purpose, code) {
  const r = await client.query(
    'SELECT id, code_hash, attempts FROM auth_codes WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
    [userId, purpose]);
  if (!r.rowCount) return new AppError(400, 'El código es inválido o ya venció. Pide uno nuevo.');
  const row = r.rows[0];
  const ok = crypto.timingSafeEqual(Buffer.from(row.code_hash, 'hex'), hashCode(code));
  if (ok) {
    await client.query('UPDATE auth_codes SET used_at=NOW() WHERE id=$1', [row.id]);
    return null;
  }
  const attempts = row.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await client.query('UPDATE auth_codes SET attempts=$2, used_at=NOW() WHERE id=$1', [row.id, attempts]);
    return new AppError(400, 'Demasiados intentos fallidos. Pide un código nuevo.');
  }
  await client.query('UPDATE auth_codes SET attempts=$2 WHERE id=$1', [row.id, attempts]);
  const left = MAX_ATTEMPTS - attempts;
  return new AppError(400, `El código es incorrecto. Te ${left === 1 ? 'queda 1 intento' : `quedan ${left} intentos`}.`);
}
