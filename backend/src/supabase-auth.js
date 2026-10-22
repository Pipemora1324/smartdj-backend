import { query } from './db.js';
import { AppError } from './errors.js';
import { SupabaseTokenError, verifySupabaseToken } from './supabase-token.js';

const tokenErrors = {
  expired: [401, 'Tu sesión expiró. Vuelve a iniciar sesión.'],
  invalid: [401, 'No autorizado: token inválido o expirado'],
  unavailable: [503, 'No pudimos validar tu sesión en este momento. Intenta de nuevo en unos segundos.'],
};
const userColumns = 'id,email,name,role';
const isUniqueViolation = (err) => err?.code === '23505';

// El nombre viene de user_metadata (lo escribe la persona al registrarse); si no sirve, se usa el inicio del correo.
const profileName = (claims) => {
  const name = typeof claims.metadata.name === 'string' ? claims.metadata.name.trim() : '';
  return (name.length >= 2 ? name : claims.email.split('@')[0]).slice(0, 80);
};

// Perfil local de una cuenta de Supabase: el ya vinculado por auth_id o uno nuevo si el correo está confirmado.
export const resolveUser = async (claims) => {
  const linked = await query(`SELECT ${userColumns} FROM users WHERE auth_id=$1`, [claims.sub]);
  if (linked.rowCount) return linked.rows[0];
  if (!claims.emailVerified || !claims.email)
    throw new AppError(403, 'Confirma tu correo con el código que te enviamos antes de entrar.', { code: 'EMAIL_NOT_VERIFIED' });
  try {
    const created = await query(`INSERT INTO users(email,name,auth_id,email_verified) VALUES($1,$2,$3,TRUE) RETURNING ${userColumns}`, [
      claims.email,
      profileName(claims),
      claims.sub,
    ]);
    return created.rows[0];
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Dos primeras peticiones a la vez: la otra ya creó el perfil, así que se lee de nuevo.
    const again = await query(`SELECT ${userColumns} FROM users WHERE auth_id=$1`, [claims.sub]);
    if (again.rowCount) return again.rows[0];
    throw new AppError(409, 'Ya existe una cuenta de SmartDJ con este correo. Escríbenos para revisarla.');
  }
};

// Exige un token de Supabase válido. req.user.sub es el id local de users, el mismo que usa establishments.owner_id.
export const requireSupabaseAuth = async (req, _res, next) => {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return next(new AppError(401, 'No autorizado: falta el token'));
  try {
    const claims = await verifySupabaseToken(token);
    const user = await resolveUser(claims);
    req.user = { sub: user.id, email: user.email, role: user.role, authId: claims.sub };
    next();
  } catch (err) {
    if (err instanceof SupabaseTokenError) {
      const [status, message] = tokenErrors[err.reason];
      return next(new AppError(status, message));
    }
    next(err);
  }
};
