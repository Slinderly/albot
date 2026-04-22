// ── Estado en memoria del bot ─────────────────────────────────────────────────
// Guarda el último mensaje por grupo y el historial reciente

const groupState = new Map();
// groupState[groupId] = {
//   lastMessageAt: Date,
//   recentMessages: [{ sender, text, timestamp }],
//   pendingAmplify: Map<msgId, { text, sender, timer }>
// }

function getGroup(groupId) {
    if (!groupState.has(groupId)) {
        groupState.set(groupId, {
            lastMessageAt:   null,
            recentMessages:  [],
            pendingAmplify:  new Map(),
        });
    }
    return groupState.get(groupId);
}

function recordMessage(groupId, sender, text) {
    const g = getGroup(groupId);
    g.lastMessageAt = new Date();
    g.recentMessages.push({ sender, text, timestamp: Date.now() });
    // Mantener solo los últimos 30 mensajes
    if (g.recentMessages.length > 30) g.recentMessages.shift();
}

function getLastMessageAt(groupId) {
    return getGroup(groupId).lastMessageAt;
}

function getRecentMessages(groupId) {
    return getGroup(groupId).recentMessages;
}

function setPendingAmplify(groupId, msgKey, data) {
    getGroup(groupId).pendingAmplify.set(msgKey, data);
}

function deletePendingAmplify(groupId, msgKey) {
    getGroup(groupId).pendingAmplify.delete(msgKey);
}

module.exports = {
    getGroup, recordMessage, getLastMessageAt,
    getRecentMessages, setPendingAmplify, deletePendingAmplify,
};
