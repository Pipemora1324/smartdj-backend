import nodemailer from 'nodemailer';
import { config } from './config.js';

// Si hay SMTP configurado (p. ej. el SMTP de Supabase), enviamos correo real.
// Si no, hacemos un "log transport" para no romper el flujo en local/demo.
let transporter = null;
if (config.smtp.host && config.smtp.user) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
} else {
  transporter = nodemailer.createTransport({ jsonTransport: true });
}

export async function sendPasswordResetEmail(to, token) {
  const link = `${config.publicAppUrl}/?reset=${encodeURIComponent(token)}`;
  const info = await transporter.sendMail({
    from: config.smtp.from,
    to,
    subject: 'SmartDJ · Restablece tu contraseña',
    text: `Recibimos una solicitud para restablecer tu contraseña.\n\nAbre este enlace (válido 30 minutos):\n${link}\n\nO usa este token: ${token}\n\nSi no fuiste tú, ignora este mensaje.`,
    html: `<p>Recibimos una solicitud para restablecer tu contraseña.</p><p><a href="${link}">Crear nueva contraseña</a> (válido 30 minutos).</p><p>O usa este token: <b>${token}</b></p><p>Si no fuiste tú, ignora este mensaje.</p>`,
  });

  // En modo demo (sin SMTP real) devolvemos el token para poder probarlo.
  const isDemo = !config.smtp.host || !config.smtp.user;
  return { demo: isDemo, info };
}