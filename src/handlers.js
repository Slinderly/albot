// ── Manejadores de mensajes ───────────────────────────────────────────────────
const path = require('path');
const fs   = require('fs');
const { amplifySellerMessage, answerGroupMessage } = require('./groq');
const { recordMessage, setPendingAmplify, deletePendingAmplify } = require('./state');
const { pushLog } = require('./logger');

// Import lazy para evitar dependencia circular con whatsapp.js
const getActiveSock = () => require('./whatsapp').getSocket();

const getCfg      = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf8'));
// Extraer número limpio de un JID (maneja formato 591XXXX:12@s.whatsapp.net)
const phoneFromJid = (jid) => jid?.split('@')[0]?.split(':')[0]?.replace(/[^0-9]/g, '') || '';

const getGroupCfg = (groupId) => {
    const cfg = getCfg();
    return cfg.groups?.find(g => g.id === groupId && g.active);
};

const isAdmin = (senderJid) => {
    const cfg = getCfg();
    const phone = phoneFromJid(senderJid);
    return cfg.adminNumbers?.some(n => n.replace(/\D/g, '') === phone);
};

// Anti-spam: no responder más de 1 vez cada 15 segundos por usuario en el mismo grupo
const _lastReply = new Map();
const canReply = (groupId, senderJid) => {
    const key = `${groupId}_${senderJid}`;
    const last = _lastReply.get(key) || 0;
    if (Date.now() - last < 15_000) return false;
    _lastReply.set(key, Date.now());
    return true;
};

async function handleGroupMessage(sock, msg) {
    const jid    = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    if (msg.key.fromMe) return;

    const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        '';

    if (!text && !msg.message?.imageMessage && !msg.message?.videoMessage) return;

    recordMessage(jid, sender, text);

    const groupCfg   = getGroupCfg(jid);
    if (!groupCfg) {
        console.log(`[debug] grupo no configurado: ${jid}`);
        return;
    }

    const cfg        = getCfg();
    const senderName = msg.pushName || phoneFromJid(sender);
    const senderJid  = sender; // para @mencionar

    // ── 1. Amplificar mensaje de cualquier usuario ────────────────────────────
    if (groupCfg.amplify?.enabled && text.length > 10) {
        // Detectar si es publicidad real o solo conversación
        const isAd = /\d+[\s]*bs|precio|vendo|venta|oferta|disponible|stock|contacto|llama|escrib|whatsapp|delivery|envio|envío|\$|usd|bob/i.test(text) || text.length > 40;

        if (isAd) {
            const delayMin = groupCfg.amplify.delayMinutes || 2;
            const delayMs  = delayMin * 60 * 1000;
            const msgKey   = `${jid}_${msg.key.id}`;
            const preview  = text.slice(0, 60) + (text.length > 60 ? '…' : '');

            pushLog('seller', {
                message:   `Publicidad detectada de @${senderName} — se reenviará en ${delayMin} min`,
                group:     groupCfg.name,
                sender:    senderName,
                senderJid: senderJid,
                preview,
                delayMin,
            });

            const timer = setTimeout(async () => {
                try {
                    const improved = await amplifySellerMessage(text, senderName, groupCfg.name);
                    const prefix   = groupCfg.amplify.prefix || '📢 *Oferta destacada:*\n\n';
                    const mention  = `@${phoneFromJid(senderJid)}`;
                    const fullMsg  = `${prefix}${improved}\n\n${mention}`;

                    // Usar siempre el socket activo al momento de enviar (no el del closure)
                    const activeSock = getActiveSock();
                    if (!activeSock) throw new Error('Sin conexión WhatsApp activa');

                    await activeSock.sendMessage(jid, {
                        text:     fullMsg,
                        mentions: [senderJid],
                    });

                    pushLog('amplify', {
                        message:   `✅ Publicidad de @${senderName} amplificada y enviada`,
                        group:     groupCfg.name,
                        sender:    senderName,
                        original:  preview,
                        improved:  improved.slice(0, 80) + (improved.length > 80 ? '…' : ''),
                    });
                } catch (e) {
                    pushLog('error', {
                        message: `Error al amplificar mensaje de ${senderName}: ${e.message}`,
                        group:   groupCfg.name,
                    });
                }
                deletePendingAmplify(jid, msgKey);
            }, delayMs);

            setPendingAmplify(jid, msgKey, { text, sender, timer });
            return; // es publicidad — no responder con IA, solo amplificar
        }
        // Si no es publicidad, cae al bloque de respuesta IA normal
    }

    // ── 2. Responder con IA a cualquier mensaje ───────────────────────────────
    if (!text || text.length < 3) return;
    if (!canReply(jid, sender)) return;

    try {
        const reply = await answerGroupMessage(text, cfg.appInfo, senderName);
        if (reply) {
            await sock.sendMessage(jid, { text: reply }, { quoted: msg });
            pushLog('reply', {
                message:  `Respondí a @${senderName}`,
                group:    groupCfg.name,
                sender:   senderName,
                question: text.slice(0, 60),
                answer:   reply.slice(0, 80),
            });
        }
    } catch (e) {
        pushLog('error', {
            message: `Error al responder a ${senderName}: ${e.message}`,
            group:   groupCfg.name,
        });
    }
}

// ── Mensajes privados (comandos admin) ────────────────────────────────────────
async function handlePrivateMessage(sock, msg) {
    const sender = msg.key.remoteJid;
    if (msg.key.fromMe) return;
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    if (!isAdmin(sender) || !text.startsWith('!')) return;

    const [cmd, ...args] = text.slice(1).trim().split(' ');
    const cfg = getCfg();

    switch (cmd.toLowerCase()) {
        case 'status': {
            const lines = cfg.groups.map(g => `• ${g.name}: ${g.active ? '✅' : '❌'}`);
            await sock.sendMessage(sender, { text: `*Estado:*\n${lines.join('\n')}` });
            break;
        }
        case 'send': {
            const groupId = args[0];
            const message = args.slice(1).join(' ');
            if (!groupId || !message) { await sock.sendMessage(sender, { text: 'Uso: !send GRUPO_ID mensaje' }); break; }
            await sock.sendMessage(groupId, { text: message });
            await sock.sendMessage(sender, { text: '✅ Enviado' });
            pushLog('info', { message: `Mensaje manual enviado a ${groupId}` });
            break;
        }
        case 'help':
            await sock.sendMessage(sender, { text: `*Comandos:*\n!status\n!send GRUPO_ID msg\n!help` });
            break;
        default:
            await sock.sendMessage(sender, { text: 'Comando desconocido. Usa !help' });
    }
}

module.exports = { handleGroupMessage, handlePrivateMessage };
