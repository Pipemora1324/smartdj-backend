import { z } from 'zod';

// Validaciones del panel del dueño (bloque C). Mensajes en español para mostrarlos tal cual.
export const VENUE_KINDS = ['restaurant', 'cafe', 'salsa_bar', 'nightclub', 'lounge', 'other'];

export const uuidParam = z.string().uuid('El identificador no es válido.');

export const venueSchema = z.object({
  name: z.string().trim().min(2, 'El nombre debe tener al menos 2 caracteres.').max(120, 'El nombre puede tener hasta 120 caracteres.'),
  kind: z.enum(VENUE_KINDS, { errorMap: () => ({ message: 'Elige un tipo de local válido.' }) }),
  ambience: z
    .string()
    .trim()
    .min(2, 'Describe el ambiente (mínimo 2 caracteres).')
    .max(500, 'La descripción puede tener hasta 500 caracteres.'),
});
// Al editar, todos los campos son opcionales pero debe venir al menos uno.
export const venuePatchSchema = venueSchema
  .extend({
    exclude_non_commercial: z.boolean({ invalid_type_error: 'Indica si se excluyen las pistas no comerciales (true o false).' }),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: 'No hay cambios para guardar.' });

// Buscador de pistas de la emisora (bloque A). Sin texto ni género se usan los géneros del tipo de local.
export const TRACK_PROVIDERS = ['jamendo', 'audius'];
export const trackSearchSchema = z.object({
  q: z.string().trim().max(100, 'La búsqueda puede tener hasta 100 caracteres.').optional().default(''),
  genre: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9 &-]{0,30}$/, 'El género no es válido.')
    .optional()
    .default(''),
  provider: z
    .enum(TRACK_PROVIDERS, { errorMap: () => ({ message: 'El proveedor debe ser jamendo o audius.' }) })
    .optional()
    .default('jamendo'),
});

// Reproductor de la emisora (bloque B). consoleId identifica la pestaña que reproduce el audio.
const consoleId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{8,64}$/, 'El identificador de la consola no es válido.');
const position = z
  .number({ invalid_type_error: 'La posición debe ser un número.' })
  .min(0, 'La posición no puede ser negativa.')
  .max(36000, 'La posición no es válida.');
export const claimSchema = z.object({ consoleId });
export const playSchema = z.object({ consoleId: consoleId.optional(), positionSeconds: position.optional() });
export const pauseSchema = z.object({ consoleId: consoleId.optional(), positionSeconds: position.optional() });
export const SKIP_REASONS = ['user', 'error'];
export const skipSchema = z.object({
  consoleId: consoleId.optional(),
  fromTrackId: uuidParam.optional(),
  reason: z
    .enum(SKIP_REASONS, { errorMap: () => ({ message: 'El motivo debe ser user o error.' }) })
    .optional()
    .default('user'),
});
export const advanceSchema = z.object({ consoleId: consoleId.optional(), fromTrackId: uuidParam.nullable() });
export const playerSettingsSchema = z
  .object({
    volume: z
      .number()
      .int('El volumen debe ser un número entero.')
      .min(0, 'El volumen va de 0 a 100.')
      .max(100, 'El volumen va de 0 a 100.'),
    mode: z.enum(['autodj', 'manual'], { errorMap: () => ({ message: 'El modo debe ser autodj o manual.' }) }),
    crossfadeSeconds: z
      .number()
      .int('El crossfade debe ser un número entero.')
      .min(0, 'El crossfade va de 0 a 20 segundos.')
      .max(20, 'El crossfade va de 0 a 20 segundos.'),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: 'No hay cambios para guardar.' });
export const queueAddSchema = z.object({
  provider: z.enum(TRACK_PROVIDERS, { errorMap: () => ({ message: 'El proveedor debe ser jamendo o audius.' }) }),
  externalId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{1,40}$/, 'La pista elegida no es válida.'),
});
export const queueOrderSchema = z.object({
  order: z.array(uuidParam).min(1, 'La cola está vacía.').max(100, 'La cola es demasiado larga.'),
});

// Peticiones dentro de la consola: "Reproducir ahora" (next) o "Añadir a la cola".
export const requestQueueSchema = z.object({
  next: z.boolean({ invalid_type_error: 'next debe ser true o false.' }).optional().default(false),
});
// Página pública: estado de las peticiones propias (ids guardados en el navegador del cliente).
export const requestIdsSchema = z
  .string({ required_error: 'Faltan las peticiones.' })
  .trim()
  .transform((v) => [
    ...new Set(
      v
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ])
  .pipe(z.array(uuidParam).min(1, 'Faltan las peticiones.').max(10, 'Se consultan hasta 10 peticiones.'));
