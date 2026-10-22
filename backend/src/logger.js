// Registro estructurado: una línea JSON por evento con nivel, hora, mensaje y contexto.
// LOG_LEVEL (debug, info, warn, error) define desde qué nivel se escribe; por defecto, info.
// Nunca registres datos personales: usa ids, y sanitizeForLog() para el texto que venga del usuario.
// Por si acaso, las claves de contexto con datos personales o secretos se ocultan siempre.
export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACTED = '[oculto]';
const SENSITIVE_KEY = /email|correo|name|nombre|guest|token|password|secret|authorization|cookie|key/i;

// Contexto seguro para el log: errores como mensaje (y stack si se pide) y claves sensibles ocultas.
export const toLogContext = (context = {}) => {
  const out = {};
  for (const [key, value] of Object.entries(context)) {
    if (value instanceof Error) {
      out[key] = value.message;
      if (value.code) out[`${key}Code`] = value.code;
    } else if (SENSITIVE_KEY.test(key) && key !== 'stack') {
      out[key] = REDACTED;
    } else {
      out[key] = value;
    }
  }
  return out;
};

const defaultWrite = (line, level) => (level >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);

export const createLogger = ({
  level = process.env.LOG_LEVEL || 'info',
  write = defaultWrite,
  now = () => new Date().toISOString(),
} = {}) => {
  const min = LEVELS[level] ?? LEVELS.info;
  const at = (name) => (msg, context) => {
    if (LEVELS[name] < min) return;
    write(JSON.stringify({ level: name, time: now(), msg, ...toLogContext(context) }), LEVELS[name]);
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
};

export const logger = createLogger();
