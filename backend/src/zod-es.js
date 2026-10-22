import { z } from 'zod';

// Mensajes de Zod en español para las validaciones que no definen uno propio
// (por ejemplo, "Number must be less than or equal to 300" llegaba en inglés al usuario).
const TYPE_NAMES = {
  string: 'un texto',
  number: 'un número',
  integer: 'un número entero',
  boolean: 'verdadero o falso',
  object: 'un objeto',
  array: 'una lista',
  date: 'una fecha',
};
const STRING_FORMATS = { uuid: 'un identificador válido', email: 'un correo válido', url: 'una URL válida', regex: 'un formato válido' };

export const spanishErrorMap = (issue, ctx) => {
  const subject = issue.path?.length ? `El campo "${issue.path.join('.')}"` : 'El valor';
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === 'undefined')
        return { message: `Falta ${issue.path?.length ? `el campo "${issue.path.join('.')}"` : 'un dato obligatorio'}.` };
      return { message: `${subject} debe ser ${TYPE_NAMES[issue.expected] || issue.expected}.` };
    case z.ZodIssueCode.too_small:
      if (issue.type === 'string') return { message: `${subject} debe tener al menos ${issue.minimum} caracteres.` };
      if (issue.type === 'array') return { message: `${subject} debe tener al menos ${issue.minimum} elementos.` };
      return { message: `${subject} debe ser ${issue.inclusive ? 'mayor o igual a' : 'mayor que'} ${issue.minimum}.` };
    case z.ZodIssueCode.too_big:
      if (issue.type === 'string') return { message: `${subject} puede tener como máximo ${issue.maximum} caracteres.` };
      if (issue.type === 'array') return { message: `${subject} puede tener como máximo ${issue.maximum} elementos.` };
      return { message: `${subject} debe ser ${issue.inclusive ? 'menor o igual a' : 'menor que'} ${issue.maximum}.` };
    case z.ZodIssueCode.invalid_string:
      return { message: `${subject} debe ser ${STRING_FORMATS[issue.validation] || 'un texto con formato válido'}.` };
    case z.ZodIssueCode.invalid_enum_value:
      return { message: `${subject} debe ser uno de: ${issue.options.join(', ')}.` };
    default:
      return { message: ctx.defaultError };
  }
};

z.setErrorMap(spanishErrorMap);
