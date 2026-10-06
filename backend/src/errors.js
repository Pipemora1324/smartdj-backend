export class AppError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const notFound = (_req,res) => res.status(404).json({ error: 'Recurso no encontrado' });
export const errorHandler = (err,_req,res,_next) => { console.error(err); const isValidation=err?.name==='ZodError'; const zodMessage=isValidation?err.issues?.[0]?.message:null; res.status(err.status || (isValidation ? 400 : 500)).json({ error: err.status ? err.message : (zodMessage || (isValidation ? 'Datos de entrada inválidos' : 'Error interno del servidor')) }); };
