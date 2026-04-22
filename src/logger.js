// ── Sistema de logs en tiempo real ────────────────────────────────────────────
const MAX_LOGS = 200;
const logs = [];
const clients = new Set(); // SSE clients

const ICONS = {
    amplify:   '📢',
    keepalive: '💬',
    reply:     '🤖',
    connect:   '📱',
    error:     '❌',
    info:      'ℹ️',
    seller:    '🛍️',
};

function pushLog(type, data) {
    const entry = {
        id:        Date.now() + Math.random(),
        type,
        icon:      ICONS[type] || '•',
        timestamp: new Date().toISOString(),
        ...data,
    };
    logs.unshift(entry); // más reciente primero
    if (logs.length > MAX_LOGS) logs.pop();

    // Emitir a todos los clientes SSE conectados
    const payload = `data: ${JSON.stringify(entry)}\n\n`;
    for (const res of clients) {
        try { res.write(payload); } catch (_) { clients.delete(res); }
    }

    // También loguear en consola
    const time = new Date().toLocaleTimeString('es');
    console.log(`[${time}] ${entry.icon} ${data.message || ''}`);
}

function getLogs() { return logs; }

function addSSEClient(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    clients.add(res);
    // Enviar los últimos 50 logs al conectarse
    const recent = logs.slice(0, 50).reverse();
    for (const entry of recent) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    res.on('close', () => clients.delete(res));
}

module.exports = { pushLog, getLogs, addSSEClient };
