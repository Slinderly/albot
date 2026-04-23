// ── Keep-alive ────────────────────────────────────────────────────────────────
const path = require('path');
const fs   = require('fs');
const cron = require('node-cron');
const { generateKeepAliveMessage } = require('./groq');
const { getLastMessageAt, getRecentMessages } = require('./state');
const { pushLog } = require('./logger');
const { getSocket } = require('./whatsapp');

const getCfg = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf8'));

let _started = false;

function startKeepAlive() {
    if (_started) return;
    _started = true;

    cron.schedule('*/15 * * * *', async () => {
        const sock = getSocket();
        if (!sock || sock.ws?.readyState !== 1) {
            pushLog('keepalive', { message: 'Socket no disponible — saltando ciclo de keep-alive' });
            return;
        }

        const cfg = getCfg();
        for (const group of cfg.groups) {
            if (!group.active || !group.keepAlive?.enabled) continue;

            const lastAt    = getLastMessageAt(group.id);
            const threshold = (group.keepAlive.silenceHoursThreshold || 3) * 60 * 60 * 1000;
            const silentMs  = lastAt ? Date.now() - lastAt.getTime() : threshold + 1;

            if (silentMs >= threshold) {
                const silentHours = (silentMs / 3600000).toFixed(1);
                pushLog('keepalive', {
                    message: `Grupo "${group.name}" lleva ${silentHours}h en silencio — generando mensaje`,
                    group:   group.name,
                    silentHours,
                });

                try {
                    const recent  = getRecentMessages(group.id);
                    const message = await generateKeepAliveMessage(group.name, recent);
                    await sock.sendMessage(group.id, { text: message });

                    pushLog('keepalive', {
                        message: `✅ Mensaje enviado a "${group.name}": ${message.slice(0, 60)}…`,
                        group:   group.name,
                        text:    message,
                    });
                } catch (e) {
                    pushLog('error', {
                        message: `Error keep-alive en "${group.name}": ${e.message}`,
                        group:   group.name,
                    });
                }
            }
        }
    });

    pushLog('info', { message: 'Keep-alive iniciado — revisando cada 15 minutos' });
}

module.exports = { startKeepAlive };
