// ── Conexión WhatsApp con código de emparejamiento ────────────────────────────
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino     = require('pino');
const path     = require('path');
const fs       = require('fs');

const { handleGroupMessage, handlePrivateMessage } = require('./handlers');
const { startKeepAlive } = require('./keepalive');
const { pushLog } = require('./logger');

const AUTH_DIR = path.join(__dirname, '../data/auth');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const logger = pino({ level: 'silent' });

let sock           = null;
let status         = 'disconnected';
let connectedPhone = null;
let keepAliveStarted = false;

const getStatus       = () => status;
const getSocket       = () => sock;
const getConnectedPhone = () => connectedPhone;

// ── Construir socket base ─────────────────────────────────────────────────────
async function buildSocket(usePairing = false) {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version }          = await fetchLatestBaileysVersion();

    const s = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys:  makeCacheableSignalKeyStore(state.keys, logger),
        },
        printQRInTerminal: false,
        // CLAVE: mobile:false permite usar requestPairingCode
        mobile: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        syncFullHistory: false,
        // No mostrar QR — vamos a pedir código
        ...(usePairing ? { qrTimeout: 0 } : {}),
    });

    s.ev.on('creds.update', saveCreds);
    return s;
}

// ── Conectar con código de emparejamiento ─────────────────────────────────────
function connectWithPairingCode(phoneNumber) {
    return new Promise(async (resolve, reject) => {
        // Limpiar sesión anterior
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        status = 'connecting';
        keepAliveStarted = false;
        let codeResolved = false;

        // Timeout global de 2 minutos
        const globalTimeout = setTimeout(() => {
            if (status !== 'connected') {
                status = 'disconnected';
                if (!codeResolved) reject(new Error('Tiempo agotado. Intenta de nuevo.'));
            }
        }, 120_000);

        try {
            sock = await buildSocket(true);
        } catch (e) {
            clearTimeout(globalTimeout);
            status = 'disconnected';
            return reject(e);
        }

        sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {

            // ── Cuando llega el QR, pedimos el código en su lugar ─────────────
            if (qr && !codeResolved) {
                codeResolved = true;
                const clean = phoneNumber.replace(/\D/g, '');
                console.log(`[pairing] Solicitando código para ${clean}…`);

                // Pequeño delay — Baileys necesita que el socket esté listo
                await new Promise(r => setTimeout(r, 500));

                try {
                    const code = await sock.requestPairingCode(clean);
                    console.log(`[pairing] Código obtenido: ${code}`);
                    resolve(code);
                } catch (err) {
                    console.error('[pairing] Error al pedir código:', err.message);
                    clearTimeout(globalTimeout);
                    status = 'disconnected';
                    reject(new Error('No se pudo obtener el código: ' + err.message));
                }
                return;
            }

            // ── Conectado exitosamente ────────────────────────────────────────
            if (connection === 'open') {
                clearTimeout(globalTimeout);
                status = 'connected';
                const me = sock.authState?.creds?.me;
                connectedPhone = me?.id?.split(':')[0]?.split('@')[0] ?? phoneNumber.replace(/\D/g,'');
                console.log(`[whatsapp] ✅ Conectado como ${connectedPhone}`);
                pushLog('connect', { message: `✅ Conectado como ${connectedPhone}` });
                if (!keepAliveStarted) {
                    keepAliveStarted = true;
                    startKeepAlive();
                }
                attachMessageHandler(sock);
                return;
            }

            // ── Conexión cerrada ──────────────────────────────────────────────
            if (connection === 'close') {
                const errCode = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output?.statusCode
                    : lastDisconnect?.error?.statusCode;

                console.log(`[whatsapp] Conexión cerrada — código: ${errCode}`);

                // restartRequired después de ingresar el código → reconectar
                if (errCode === DisconnectReason.restartRequired && codeResolved) {
                    console.log('[whatsapp] Reconectando tras código ingresado…');
                    status = 'connecting';
                    setTimeout(() => reconnect(), 2000);
                    return;
                }

                if (errCode === DisconnectReason.loggedOut) {
                    clearTimeout(globalTimeout);
                    status = 'disconnected';
                    connectedPhone = null;
                    console.log('[whatsapp] Sesión cerrada (logout)');
                    return;
                }

                // Si ya estaba conectado → reconectar automáticamente
                if (status === 'connected') {
                    status = 'connecting';
                    setTimeout(() => reconnect(), 4000);
                    return;
                }

                // Si aún no obtuvimos el código → error
                if (!codeResolved) {
                    clearTimeout(globalTimeout);
                    status = 'disconnected';
                    reject(new Error('Conexión cerrada antes de obtener el código. Intenta de nuevo.'));
                }
            }
        });
    });
}

// ── Reconexión automática (usa sesión guardada) ───────────────────────────────
async function reconnect() {
    try {
        sock = await buildSocket(false);
        attachMessageHandler(sock);

        sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
            if (connection === 'open') {
                status = 'connected';
                const me = sock.authState?.creds?.me;
                connectedPhone = me?.id?.split(':')[0]?.split('@')[0] ?? connectedPhone;
                console.log(`[whatsapp] Reconectado como ${connectedPhone}`);
                pushLog('connect', { message: `Reconectado como ${connectedPhone}` });
                if (!keepAliveStarted) {
                    keepAliveStarted = true;
                    startKeepAlive();
                }
            }
            if (connection === 'close') {
                const code = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output?.statusCode
                    : null;
                if (code === DisconnectReason.loggedOut) {
                    status = 'disconnected';
                    connectedPhone = null;
                    keepAliveStarted = false;
                    console.log('[whatsapp] Logout — sesión terminada');
                } else {
                    console.log('[whatsapp] Reconectando…');
                    setTimeout(() => reconnect(), 4000);
                }
            }
        });
    } catch (e) {
        console.error('[whatsapp] Error al reconectar:', e.message);
        setTimeout(() => reconnect(), 6000);
    }
}

// ── Manejador de mensajes ─────────────────────────────────────────────────────
function attachMessageHandler(s) {
    s.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.message) continue;
            const jid     = msg.key.remoteJid;
            const isGroup = jid?.endsWith('@g.us');
            if (jid === 'status@broadcast') continue;
            try {
                if (isGroup) await handleGroupMessage(s, msg);
                else         await handlePrivateMessage(s, msg);
            } catch (e) {
                console.error('[msg-error]', e.message);
            }
        }
    });
}

// ── Desconectar ───────────────────────────────────────────────────────────────
async function disconnect() {
    if (sock) {
        try { await sock.logout(); } catch (_) {}
        sock = null;
    }
    status = 'disconnected';
    connectedPhone = null;
    keepAliveStarted = false;
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    console.log('[whatsapp] Desconectado y sesión eliminada');
}

// ── Arranque inicial (si ya hay sesión guardada) ──────────────────────────────
async function tryAutoConnect() {
    const credsFile = path.join(AUTH_DIR, 'creds.json');
    if (!fs.existsSync(credsFile)) return;
    console.log('[whatsapp] Sesión guardada encontrada — reconectando…');
    status = 'connecting';
    await reconnect();
}

module.exports = {
    connectWithPairingCode,
    disconnect,
    getStatus,
    getSocket,
    getConnectedPhone,
    tryAutoConnect,
};
