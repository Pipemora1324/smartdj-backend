import { z } from 'zod';

// Validaciones del panel del dueño (bloque C). Mensajes en español para mostrarlos tal cual.
export const VENUE_KINDS = ['restaurant', 'cafe', 'salsa_bar', 'nightclub', 'lounge', 'other'];
export const OWNER_STATUSES = ['accepted', 'rejected', 'played'];

export const uuidParam = z.string().uuid('El identificador no es válido.');

export const venueSchema = z.object({
  name: z.string().trim().min(2, 'El nombre debe tener al menos 2 caracteres.').max(120, 'El nombre puede tener hasta 120 caracteres.'),
  kind: z.enum(VENUE_KINDS, { errorMap: () => ({ message: 'Elige un tipo de local válido.' }) }),
  ambience: z.string().trim().min(2, 'Describe el ambiente (mínimo 2 caracteres).').max(500, 'La descripción puede tener hasta 500 caracteres.'),
});
// Al editar, todos los campos son opcionales pero debe venir al menos uno.
export const venuePatchSchema = venueSchema.partial().refine((d) => Object.keys(d).length > 0, { message: 'No hay cambios para guardar.' });

export const requestStatusSchema = z.object({
  status: z.enum(OWNER_STATUSES, { errorMap: () => ({ message: 'El estado debe ser accepted, rejected o played.' }) }),
});

export const listLimit = z.preprocess((v) => (v === undefined ? 50 : v), z.coerce.number().int().min(1).max(100));
