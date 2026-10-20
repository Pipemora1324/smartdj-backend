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

const codeSubjects = {
  verify_email: 'SmartDJ · Tu código de verificación',
  reset_password: 'SmartDJ · Código para restablecer tu contraseña',
};
const codeIntros = {
  verify_email: 'Usa este código para verificar tu correo en SmartDJ:',
  reset_password: 'Usa este código para restablecer tu contraseña de SmartDJ:',
};

// Envía el código de 6 dígitos. Prioridad: Resend, luego SMTP y, si no hay
// ninguno, solo lo deja en el log del servidor (nunca en la respuesta HTTP).
export async function sendAuthCode(to, code, purpose) {
  const subject = codeSubjects[purpose];
  const text = `${codeIntros[purpose]}\n\n${code}\n\nVence en 10 minutos y solo sirve una vez.\nSi no fuiste tú, ignora este mensaje.`;
  const html = `<p>${codeIntros[purpose]}</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p>Vence en 10 minutos y solo sirve una vez.</p><p>Si no fuiste tú, ignora este mensaje.</p>`;

  if (config.resendApiKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.smtp.from, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Resend respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return;
  }
  if (config.smtp.host && config.smtp.user) {
    await transporter.sendMail({ from: config.smtp.from, to, subject, text, html });
    return;
  }
  console.log(`[auth] Sin proveedor de correo. Código ${purpose} para ${to}: ${code}`);
}