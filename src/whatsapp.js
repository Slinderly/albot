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

let sock             = null;
let status           = 'disconnected';
let connectedPhone   = null;
let keepAliveStarted = false;
let reconnectTimer   = null;   // evitar timers duplicados
let reconnectAttempt = 0;      // para backoff exponencial

const getStatus         = () => status;
const getSocket         = () => sock;
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
        mobile: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        syncFullHistory: false,
        ...(usePairing ? { qrTimeout: 0 } : {}),
    });

    s.ev.on('creds.update', saveCreds);
    return s;
}

// ── Programar reconexión con backoff exponencial ──────────────────────────────
function scheduleReconnect() {
    if (reconnectTimer) return;      // ya hay uno pendiente
    if (status === 'connected') return; // ya conectado, no hacer nada
    reconnectAttempt++;
    const delay = Math.min(4000 * Math.pow(2, reconnectAttempt - 1), 60_000);
    console.log(`[whatsapp] Reconectando en ${delay / 1000}s (intento ${reconnectAttempt})…`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (status !== 'connected') reconnect(); // verificar de nuevo antes de ejecutar
    }, delay);
}

// ── Conectar con código de emparejamiento ─────────────────────────────────────
function connectWithPairingCode(phoneNumber) {
    return new Promise(async (resolve, reject) => {
        // Limpiar sesión anterior
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        status           = 'connecting';
        keepAliveStarted = false;
        reconnectAttempt = 0;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

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
                status           = 'connected';
                reconnectAttempt = 0; // resetear backoff al conectar
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

                if (errCode === DisconnectReason.loggedOut) {
                    clearTimeout(globalTimeout);
                    status           = 'disconnected';
                    connectedPhone   = null;
                    keepAliveStarted = false;
                    console.log('[whatsapp] Sesión cerrada (logout)');
                    return;
                }

                // restartRequired después de ingresar el código → reconectar solo si no estamos ya conectados
                if (errCode === DisconnectReason.restartRequired) {
                    if (status !== 'connected') {
                        console.log('[whatsapp] Reconectando tras restartRequired…');
                        status = 'connecting';
                        scheduleReconnect();
                    }
                    return;
                }

                // Si ya estaba conectado → reconectar automáticamente
                if (status === 'connected') {
                    status = 'connecting';
                    scheduleReconnect();
                    return;
                }                // Si aún no obtuvimos el código → error
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
    // Si ya hay un socket conectado, no hacer nada
    if (status === 'connected') {
        console.log('[whatsapp] Ya conectado — ignorando llamada a reconnect()');
        return;
    }

    try {
        // Cerrar socket anterior limpiamente y esperar antes de crear uno nuevo
        if (sock) {
            try { sock.ev.removeAllListeners(); sock.ws?.close(); } catch (_) {}
            sock = null;
            // Esperar 1.5s para que WhatsApp libere la sesión anterior
            await new Promise(r => setTimeout(r, 1500));
        }

        sock = await buildSocket(false);
        attachMessageHandler(sock);

        let wasOpen = false; // solo reconectar si llegó a estar conectado

        sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
            if (connection === 'open') {
                wasOpen          = true;
                status           = 'connected';
                reconnectAttempt = 0;
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

                console.log(`[whatsapp] connection.close — código: ${code} | wasOpen: ${wasOpen}`);

                if (code === DisconnectReason.loggedOut) {
                    status           = 'disconnected';
                    connectedPhone   = null;
                    keepAliveStarted = false;
                    console.log('[whatsapp] Logout — sesión terminada');
                } else if (code === DisconnectReason.connectionReplaced) {
                    // Otra instancia tomó el control. Esperar 5s y reconectar una vez.
                    // Si hay otra instancia corriendo, el loop se rompe porque esa también
                    // recibirá 440 cuando esta reconecte.
                    console.log('[whatsapp] Sesión reemplazada — reconectando en 5s…');
                    status = 'connecting';
                    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
                    reconnectTimer = setTimeout(() => {
                        reconnectTimer = null;
                        if (status !== 'connected') reconnect();
                    }, 5000);
                } else if (code === DisconnectReason.restartRequired) {
                    // Baileys emite restartRequired como parte normal del protocolo
                    // Solo reconectar si aún no estamos conectados
                    if (status !== 'connected') {
                        status = 'connecting';
                        scheduleReconnect();
                    }
                } else if (wasOpen) {
                    // Desconexión real después de haber estado conectado
                    status = 'connecting';
                    scheduleReconnect();
                } else {
                    // Cerró antes de abrir — no reconectar
                    console.log('[whatsapp] Conexión cerrada antes de abrirse — no reconectando');
                    status = 'disconnected';
                }
            }
        });
    } catch (e) {
        console.error('[whatsapp] Error al reconectar:', e.message);
        scheduleReconnect();
    }
}

// ── Manejador de mensajes ─────────────────────────────────────────────────────
// Se registra UNA sola vez por socket — no acumula listeners
function attachMessageHandler(s) {
    s.ev.off('messages.upsert', onMessage); // quitar si ya existía
    s.ev.on('messages.upsert', onMessage);
}

async function onMessage({ messages, type }) {
    if (type !== 'notify') return;
    for (const msg of messages) {
        if (!msg.message) continue;
        const jid     = msg.key.remoteJid;
        const isGroup = jid?.endsWith('@g.us');
        if (jid === 'status@broadcast') continue;
        try {
            if (isGroup) await handleGroupMessage(sock, msg);
            else         await handlePrivateMessage(sock, msg);
        } catch (e) {
            console.error('[msg-error]', e.message);
        }
    }
}

// ── Desconectar ───────────────────────────────────────────────────────────────
async function disconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (sock) {
        try { sock.ev.removeAllListeners(); await sock.logout(); } catch (_) {}
        sock = null;
    }
    status           = 'disconnected';
    connectedPhone   = null;
    keepAliveStarted = false;
    reconnectAttempt = 0;
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
