// ── GroupBot — Servidor web + bot ─────────────────────────────────────────────
const express = require('express');
const path    = require('path');
const fs      = require('fs');

const { connectWithPairingCode, disconnect, getStatus, getConnectedPhone, tryAutoConnect } = require('./src/whatsapp');
const { getLogs, addSSEClient } = require('./src/logger');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CFG_FILE = path.join(__dirname, 'config.json');
const readCfg  = () => JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
const saveCfg  = (data) => fs.writeFileSync(CFG_FILE, JSON.stringify(data, null, 2));

// ── API ───────────────────────────────────────────────────────────────────────

// Estado de conexión
app.get('/api/status', (req, res) => {
    res.json({ status: getStatus(), phone: getConnectedPhone() });
});

// Solicitar código de emparejamiento
app.post('/api/connect', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Falta el número' });

    if (getStatus() === 'connected') {
        return res.status(400).json({ success: false, message: 'Ya hay una sesión activa. Desconecta primero.' });
    }

    try {
        // connectWithPairingCode resuelve con el código cuando WhatsApp lo genera
        const code = await connectWithPairingCode(phone);
        res.json({ success: true, code });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Desconectar
app.post('/api/disconnect', async (req, res) => {
    await disconnect();
    res.json({ success: true });
});

// Leer config
app.get('/api/config', (req, res) => {
    res.json(readCfg());
});

// Guardar config
app.post('/api/config', (req, res) => {
    try {
        saveCfg(req.body);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Forzar keep-alive en un grupo ahora mismo (para probar)
app.post('/api/groups/:groupId/keepalive-test', async (req, res) => {
    const { getSocket } = require('./src/whatsapp');
    const sock = getSocket();
    if (!sock || getStatus() !== 'connected') {
        return res.status(400).json({ success: false, message: 'Bot no conectado' });
    }
    const groupId = decodeURIComponent(req.params.groupId);
    const cfg = readCfg();
    const group = cfg.groups.find(g => g.id === groupId);
    if (!group) return res.status(404).json({ success: false, message: 'Grupo no encontrado' });

    const { generateKeepAliveMessage } = require('./src/groq');
    const { getRecentMessages } = require('./src/state');
    const { pushLog } = require('./src/logger');
    try {
        const recent  = getRecentMessages(groupId);
        const message = await generateKeepAliveMessage(group.name, recent);
        await sock.sendMessage(groupId, { text: message });
        pushLog('keepalive', {
            message: `✅ Keep-alive manual enviado a "${group.name}"`,
            group:   group.name,
            text:    message,
        });
        res.json({ success: true, message });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Logs históricos
app.get('/api/logs', (req, res) => {
    res.json(getLogs());
});

// Logs en tiempo real (Server-Sent Events)
app.get('/api/logs/stream', (req, res) => {
    addSSEClient(res);
});

// Escanear grupos del WhatsApp conectado
app.get('/api/groups/scan', async (req, res) => {
    const { getSocket } = require('./src/whatsapp');
    const sock = getSocket();
    if (!sock || getStatus() !== 'connected') {
        return res.status(400).json({ success: false, message: 'Bot no conectado' });
    }
    try {
        // Obtener todos los chats
        const chats = await sock.groupFetchAllParticipating();
        const groups = Object.values(chats).map(g => ({
            id:   g.id,
            name: g.subject || g.id,
            participants: g.participants?.length || 0,
        })).sort((a, b) => a.name.localeCompare(b.name));
        res.json({ success: true, groups });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Enviar mensaje manual a un grupo
app.post('/api/send', async (req, res) => {
    const { groupId, text } = req.body;
    if (!groupId || !text) return res.status(400).json({ success: false, message: 'Faltan datos' });
    const { getSocket } = require('./src/whatsapp');
    const sock = getSocket();
    if (!sock || getStatus() !== 'connected') {
        return res.status(400).json({ success: false, message: 'Bot no conectado' });
    }
    try {
        await sock.sendMessage(groupId, { text });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ── Arranque ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🤖 GroupBot panel: http://localhost:${PORT}\n`);
    tryAutoConnect();
});
