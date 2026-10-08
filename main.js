const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Bot, GrammyError, HttpError } = require('grammy');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ──────────────────────────────────────────────
// CONFIGURACIÓN
// ──────────────────────────────────────────────
const TOKEN_TELEGRAM = process.env.TOKEN_TELEGRAM;
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '0');
const PUERTO = parseInt(process.env.PORT || 10000);

if (!TOKEN_TELEGRAM) {
  console.error('❌ Falta TOKEN_TELEGRAM en variables de entorno');
  process.exit(1);
}

// ──────────────────────────────────────────────
// ALMACENAMIENTO DE SESIONES
// ──────────────────────────────────────────────
const SESIONES_ACTIVAS = new Map();

// ──────────────────────────────────────────────
// SERVIDOR WEB — MANTIENE VIVO EN RENDER
// ──────────────────────────────────────────────
const app = express();

app.get('/', (req, res) => {
  res.send('✅ Bot activo y funcionando 24/7');
});

function iniciarServidorWeb() {
  app.listen(PUERTO, '0.0.0.0', () => {
    console.log(`🌐 Servidor web activo en el puerto ${PUERTO}`);
  });
}

// ──────────────────────────────────────────────
// FUNCIONES AUXILIARES
// ──────────────────────────────────────────────
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function limpiarNumero(numero) {
  return numero.replace(/\D/g, '');
}

// ──────────────────────────────────────────────
// CLASE SESIÓN WHATSAPP
// ──────────────────────────────────────────────
class SesionWhatsApp {
  constructor(nombre, authDir, numero = null) {
    this.nombre = nombre;
    this.authDir = authDir;
    this.numero = numero;
    this.sock = null;
    this.estado = 'DESCONECTADO';
    this.qr = null;
  }

  async iniciar() {
    try {
      if (!fs.existsSync(this.authDir)) {
        fs.mkdirSync(this.authDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

      this.sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        syncFullHistory: false
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;
        
        if (qr) {
          this.qr = qr;
          this.estado = 'ESPERANDO_QR';
          console.log(`📱 [${this.nombre}] QR disponible`);
        }

        if (connection === 'open') {
          this.estado = 'CONECTADO';
          this.qr = null;
          console.log(`✅ [${this.nombre}] SESIÓN CONECTADA`);
        }

        if (connection === 'close') {
          const codigo = lastDisconnect?.error?.output?.statusCode;
          const razon = DisconnectReason[codigo];
          this.estado = 'DESCONECTADO';
          console.log(`❌ [${this.nombre}] Desconectado: ${razon}`);
          
          if (codigo !== DisconnectReason.loggedOut) {
            console.log(`🔁 [${this.nombre}] Reintentando...`);
            setTimeout(() => this.iniciar(), 5000);
          } else {
            this.qr = null;
          }
        }
      });

      // Escuchar mensajes entrantes en WhatsApp
      this.sock.ev.on('messages.upsert', async (m) => {
        const mensaje = m.messages[0];
        if (!mensaje.key.fromMe && mensaje.message) {
          await this.manejarMensajeEntrante(mensaje);
        }
      });

      return true;
    } catch (error) {
      console.log(`❌ [${this.nombre}] Error al iniciar: ${error.message}`);
      return false;
    }
  }

  async manejarMensajeEntrante(mensaje) {
    const remitente = mensaje.key.remoteJid;
    const texto = mensaje.message.conversation || mensaje.message.extendedTextMessage?.text || '';
    const textoLimpio = texto.trim();

    // 📱 En WhatsApp: .code +NUMERO → genera código de vinculación
    const matchCode = textoLimpio.match(/^\.code\s+(\+\d+)/i);
    if (matchCode) {
      const numeroDestino = matchCode[1];
      const resultado = await this.generarCodigoVinculacionReal(numeroDestino);
      await this.sock.sendMessage(remitente, { text: resultado.mensaje });
      return;
    }

    // 📱 En WhatsApp: .reportar +NUMERO → reporta y bloquea
    const matchReportar = textoLimpio.match(/^\.reportar\s+(\+?\d+)/i);
    if (matchReportar) {
      const numeroDestino = matchReportar[1];
      const resultado = await this.reportarYbloquear(numeroDestino);
      await this.sock.sendMessage(remitente, { text: resultado });
      return;
    }
  }

  // 🔑 Genera código REAL de vinculación de WhatsApp
  async generarCodigoVinculacionReal(numeroConCodigoPais) {
    if (!this.sock || this.estado === 'CONECTADO') {
      return { exito: false, mensaje: '❌ Sesión ya conectada o no disponible' };
    }
    
    try {
      const numeroLimpio = limpiarNumero(numeroConCodigoPais);
      
      if (this.sock.authState.creds.registered) {
        return { exito: false, mensaje: '❌ Esta sesión ya está vinculada' };
      }
      
      const codigo = await this.sock.requestPairingCode(numeroLimpio);
      console.log(`🔑 [${this.nombre}] Código para ${numeroConCodigoPais}: ${codigo}`);
      
      return { 
        exito: true, 
        mensaje: `🔑 Código de vinculación para ${numeroConCodigoPais}:\n\n*${codigo}*\n\n📱 Abre WhatsApp → Dispositivos vinculados → "Vincular con número de teléfono"\n⏳ Válido ~1 minuto`
      };
    } catch (error) {
      return { 
        exito: false, 
        mensaje: `❌ Error: ${error.message.substring(0, 50)}`
      };
    }
  }

  // ⚠️ Reporta como spam + Bloquea
    async reportarYbloquear(numeroObjetivo) {
    if (this.estado !== 'CONECTADO' || !this.sock) {
      return `❌ [${this.nombre}] No conectado`;
    }
    
    try {
      // 🧹 Limpieza mejorada del número
      let numeroLimpio = numeroObjetivo.replace(/\D/g, '');
      
      // Si no tiene código de país, asumimos +51 (Perú)
      if (!numeroLimpio.startsWith('51') && numeroLimpio.length === 9) {
        numeroLimpio = '51' + numeroLimpio;
      }
      
      const jid = `${numeroLimpio}@s.whatsapp.net`;
      
      console.log(`🔍 Intentando con JID: ${jid}`);
      
      // 1️⃣ Reportar como spam
      await this.sock.chatModify(
        { delete: true, lastMessages: [{ key: { remoteJid: jid }, messageTimestamp: Date.now() }] },
        jid
      );
      
      // 2️⃣ Bloquear
      await this.sock.updateBlockStatus(jid, 'block');
      
      console.log(`✅ [${this.nombre}] Reportó y BLOQUEÓ a ${numeroObjetivo} → ${jid}`);
      return `✅ [${this.nombre}] ✅ Reportado + Bloqueado → ${numeroObjetivo}`;
    } catch (error) {
      console.log(`❌ [${this.nombre}] Error: ${error.message}`);
      return `⚠️ [${this.nombre}] Falló: ${error.message.substring(0, 80)}`;
    }
    }
  

  obtenerEstado() {
    if (this.estado === 'CONECTADO') return '✅ CONECTADO';
    if (this.qr) return '📱 Esperando código';
    return '⏳ Desconectado';
  }

  cerrar() {
    if (this.sock) this.sock.end();
  }
}

// ──────────────────────────────────────────────
// BOT DE TELEGRAM
// ──────────────────────────────────────────────
const bot = new Bot(TOKEN_TELEGRAM);

// /start
bot.command('start', async (ctx) => {
  await ctx.reply(
    `╭━━━━━━━━━━━━━━━━━━━━╮
 🤖 BOT DE WHATSAPP
╰━━━━━━━━━━━━━━━━━━━━╯

👋 ¡Hola! Bienvenido
Soy tu asistente automatizado. ✨

╭─── 📱 TELEGRAM ───╮

🔗 ".code +NUMERO"
└─ Generar código de vinculación

🚫 "/reportar +NUMERO"
└─ Reportar y bloquear en TODAS las sesiones

📊 "/estado"
└─ Ver el estado de tus sesiones

➕ "/agregar NOMBRE"
└─ Agregar una nueva sesión

╰────────────────────╯

╭─── 💬 WHATSAPP ───╮

🔗 ".code +NUMERO"
└─ Generar código de vinculación

🚫 ".reportar +NUMERO"
└─ Reportar y bloquear

╰────────────────────╯

✨ Selecciona un comando para comenzar.`
    
  );
});

// 🔑 .code +NUMERO en Telegram → genera código real
bot.on('message:text', async (ctx, next) => {
  const texto = ctx.message.text?.trim();
  
  const matchCode = texto?.match(/^\.code\s+(\+\d+)/i);
  if (matchCode && ctx.from.id === ADMIN_ID) {
    const numeroDestino = matchCode[1];
    
    let sesionDisponible = null;
    for (const sesion of SESIONES_ACTIVAS.values()) {
      if (sesion.estado === 'ESPERANDO_QR' || sesion.estado === 'DESCONECTADO') {
        sesionDisponible = sesion;
        break;
      }
    }
    
    if (!sesionDisponible) {
      await ctx.reply('⚠️ No hay sesiones disponibles.\nUsa: /agregar NOMBRE');
      return;
    }
    
    const res = await sesionDisponible.generarCodigoVinculacionReal(numeroDestino);
    await ctx.reply(res.mensaje, { parse_mode: 'Markdown' });
    return;
  }
  
  await next();
});

// ⚠️ /reportar +NUMERO en Telegram → reporta y bloquea en TODAS las sesiones
bot.command('reportar', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.reply('🔒 Sin permiso');
    return;
  }
  
  const numero = ctx.match;
  if (!numero) {
    await ctx.reply('Uso: /reportar +51972098722');
    return;
  }
  
  await ctx.reply(`🚀 Reportando y bloqueando en ${SESIONES_ACTIVAS.size} sesiones...\n🎯: ${numero}`);
  
  const resultados = [];
  for (const [nombre, sesion] of SESIONES_ACTIVAS) {
    const res = await sesion.reportarYbloquear(numero);
    resultados.push(res);
    await delay(600);
  }
  
  await ctx.reply('📋 RESULTADOS:\n' + resultados.join('\n'));
});

// 📊 /estado
bot.command('estado', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  
  let msg = '📊 ESTADO DE SESIONES:\n\n';
  let conectadas = 0;
  for (const [nombre, sesion] of SESIONES_ACTIVAS) {
    const estado = sesion.obtenerEstado();
    if (sesion.estado === 'CONECTADO') conectadas++;
    msg += `${estado} | ${nombre}\n`;
  }
  msg += `\nTotal: ${SESIONES_ACTIVAS.size} | Conectadas: ${conectadas}`;
  await ctx.reply(msg);
});

// ➕ /agregar NOMBRE
bot.command('agregar', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  
  const nombre = ctx.match || `Sesion_${SESIONES_ACTIVAS.size + 1}`;
  const authDir = path.join(__dirname, `auth_${nombre}`);
  
  const sesion = new SesionWhatsApp(nombre, authDir);
  SESIONES_ACTIVAS.set(nombre, sesion);
  await sesion.iniciar();
  
  await ctx.reply(`✅ Sesión "${nombre}" agregada.\n\nUsa:\n.code +519XXXXXXX → para vincular con número`);
  console.log(`➕ Sesión "${nombre}" agregada`);
});

bot.catch((err) => console.error('❌ Error bot:', err));

// ──────────────────────────────────────────────
// INICIALIZACIÓN
// ──────────────────────────────────────────────
async function iniciarTodo() {
  console.log('🤖 Iniciando Bot...');
  iniciarServidorWeb();
  await bot.start({ onStart: (info) => console.log(`🤖 Bot en línea: @${info.username}`) });
}

iniciarTodo().catch(err => {
  console.error('❌ Error al iniciar:', err);
  process.exit(1);
});
        
