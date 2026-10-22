// Utilidades de Server-Sent Events compartidas por los avisos en vivo.
export const SSE_HEARTBEAT_MS = 15 * 1000;

// Cabeceras de un stream SSE; X-Accel-Buffering evita que nginx lo acumule.
export const openEventStream = (res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
};

export const writeEvent = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

// Comentario periódico para que proxies y navegadores no corten la conexión por inactividad.
export const startHeartbeat = (res) => setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
