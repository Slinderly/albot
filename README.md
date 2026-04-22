# GroupBot — Bot de WhatsApp para grupos

## Qué hace

1. **Mantiene el grupo activo** — si hay X horas de silencio, genera y envía un mensaje automático con IA
2. **Amplifica vendedores** — cuando un vendedor configurado publica algo, el bot lo mejora con IA y lo reenvía como publicidad más atractiva
3. **Responde preguntas** — cuando alguien menciona al bot (`@bot`, `wibca`, etc.) responde sobre tu app
4. **Comandos de admin** — por mensaje privado puedes controlar el bot

## Instalación

```bash
cd GroupBot
npm install
```

## Configuración

Edita `config.json`:

```json
{
  "groqApiKey": "gsk_...",        ← tu API Key de Groq (gratis en console.groq.com/keys)

  "groups": [{
    "id": "120363..@g.us",        ← ID del grupo (ver abajo cómo obtenerlo)
    "name": "Mi grupo",
    "active": true,

    "keepAlive": {
      "enabled": true,
      "silenceHoursThreshold": 3  ← horas de silencio antes de que el bot hable
    },

    "sellers": [
      "5491112345678"              ← números de los vendedores (con código de país, sin +)
    ],

    "amplify": {
      "enabled": true,
      "delayMinutes": 2,           ← espera X minutos antes de reenviar mejorado
      "prefix": "📢 *Oferta destacada:*\n\n"
    }
  }],

  "botTriggers": ["@bot", "wibca"],  ← palabras que activan al bot para responder

  "adminNumbers": ["5491100000000"]  ← tu número para comandos privados
}
```

## Cómo obtener el ID de un grupo

1. Arranca el bot una vez (`npm start`)
2. Manda cualquier mensaje al grupo
3. En la consola verás algo como: `[group-message] 120363XXXXXX@g.us`
4. Copia ese ID y pégalo en `config.json`

## Ejecutar

```bash
npm start
```

Escanea el QR con WhatsApp → Dispositivos vinculados → Vincular dispositivo.

## Comandos de admin (por mensaje privado al número del bot)

| Comando | Descripción |
|---|---|
| `!status` | Ver estado de todos los grupos |
| `!send GRUPO_ID mensaje` | Enviar mensaje a un grupo |
| `!help` | Ver todos los comandos |

## Cómo funciona la amplificación

1. Un vendedor de la lista publica algo en el grupo
2. El bot espera `delayMinutes` minutos (para no parecer inmediato)
3. Llama a Groq con el mensaje original
4. Reenvía la versión mejorada con el prefijo configurado

## Estructura

```
GroupBot/
  index.js          — arranque y conexión WhatsApp
  config.json       — toda la configuración
  src/
    groq.js         — cliente Groq (amplificar, keepalive, responder)
    handlers.js     — lógica de mensajes entrantes
    keepalive.js    — scheduler para mantener grupos activos
    state.js        — estado en memoria (último mensaje, historial)
  data/
    auth/           — sesión de WhatsApp (generada automáticamente)
```
