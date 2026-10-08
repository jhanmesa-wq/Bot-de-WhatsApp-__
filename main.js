const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Bot, GrammyError, HttpError } = require('grammy');
const express = require('express');
const pino = require('pino');
const { v4: uuidv4 } = require('uuid');
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
const CODIGOS_VINCULACION = new Map();

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
function generarCodigoVinculacion() {
  const caracteres = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let codigo = '';
  for (let i = 0; i < 8; i++) {
    codigo += caracteres.charAt(Math.floor(Math.random() * caracteres.length));
  }
  return codigo;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    this.codigoVinculacion = null;
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
          this.codigoVinculacion = 'CONECTADO';
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
            this.codigoVinculacion = null;
            this.qr = null;
          }
        }
      });

      // Escuchar mensajes entrantes
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
    
    if (texto.trim() === '.code') {
      const codigo = generarCodigoVinculacion();
      CODIGOS_VINCULACION.set(codigo, {
        sesion: this.nombre,
        remitente,
        fecha: new Date()
      });
      
      await this.sock.sendMessage(remitente, {
        text: `🔑 Tu código de vinculación es:\n\n*${codigo}*\n\nÚsalo para vincular tu cuenta. Válido por 5 minutos.`
      });
      
      console.log(`🔑 [${this.nombre}] Código generado para ${remitente}: ${codigo}`);
      
      // Expirar código después de 5 min
      setTimeout(() => {
        CODIGOS_VINCULACION.delete(codigo);
      }, 5 * 60 * 1000);
    }
  }

  async reportarNumero(numeroObjetivo) {
    if (this.estado !== 'CONECTADO' || !this.sock) {
      return `❌ [${this.nombre}] No conectado`;
    }
    
    try {
      const jid = numeroObjetivo.includes('@') 
        ? numeroObjetivo 
        : `${numeroObjetivo}@s.whatsapp.net`;
      
      // Reportar contacto
      await this.sock.chatModify(
        { delete: true, lastMessages: [{ key: { remoteJid: jid }, messageTimestamp: Date.now() }] },
        jid
      );
      
      // Notificar al usuario que fue reportado
      console.log(`✅ [${this.nombre}] Reportó a ${numeroObjetivo}`);
      return `✅ [${this.nombre}] Reportó a ${numeroObjetivo}`;
    } catch (error) {
      return `⚠️ [${this.nombre}] Falló: ${error.message.substring(0, 60)}`;
    }
  }

  obtenerCodigoVinculacion() {
    if (this.estado === 'CONECTADO') return 'CONECTADO';
    if (this.qr) return 'ESCANEA_QR';
    return this.codigoVinculacion || 'CARGANDO...';
  }

  cerrar() {
    if (this.sock) {
      this.sock.end();
    }
  }
}

// ──────────────────────────────────────────────
// BOT DE TELEGRAM
// ──────────────────────────────────────────────
const bot = new Bot(TOKEN_TELEGRAM);

// Comando /start
bot.command('start', async (ctx) => {
  await ctx.reply('👋 ¡Hola! Soy tu bot de WhatsApp y estoy aquí para ayudarte.\n\n' +
    'Comandos disponibles:\n' +
    '/reportar NUMERO - Reportar un número\n' +
    '/codigos - Ver códigos de vinculación\n' +
    '/estado - Ver estado de las sesiones\n' +
    '/agregar NOMBRE - Agregar nueva sesión');
});

// Comando /reportar
bot.command('reportar', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.reply('🔒 Sin permiso');
    return;
  }
  
  const numero = ctx.match;
  if (!numero) {
    await ctx.reply('Uso: /reportar NUMERO\nEjemplo: /reportar 987654321');
    return;
  }
  
  await ctx.reply(`🚀 Reportando en ${SESIONES_ACTIVAS.size} sesiones...\n🎯: ${numero}`);
  
  const resultados = [];
  for (const [nombre, sesion] of SESIONES_ACTIVAS) {
    const res = await sesion.reportarNumero(numero);
    resultados.push(res);
    await delay(500);
  }
  
  await ctx.reply('📋 RESULTADOS:\n' + resultados.join('\n'));
});

// Comando /codigos
bot.command('codigos', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  
  let msg = '📋 CÓDIGOS DE VINCULACIÓN:\n\n';
  for (const [nombre, sesion] of SESIONES_ACTIVAS) {
    const estado = sesion.obtenerCodigoVinculacion();
    if (estado === 'CONECTADO') {
      msg += `✅ ${nombre}: CONECTADO\n`;
    } else if (estado === 'ESCANEA_QR') {
      msg += `📱 ${nombre}: Escanea QR\n`;
    } else {
      msg += `⏳ ${nombre}: ${estado}\n`;
    }
  }
  
  if (CODIGOS_VINCULACION.size > 0) {
    msg += '\n🔑 Códigos activos generados:\n';
    for (const [cod, datos] of CODIGOS_VINCULACION) {
      msg += `${cod} → ${datos.sesion}\n`;
    }
  }
  
  await ctx.reply(msg);
});

// Comando /estado
bot.command('estado', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  
  let conectadas = 0;
  for (const sesion of SESIONES_ACTIVAS.values()) {
    if (sesion.estado === 'CONECTADO') conectadas++;
  }
  
  await ctx.reply(
    `📊 ESTADO:\n` +
    `Total sesiones: ${SESIONES_ACTIVAS.size}\n` +
    `Conectadas: ${conectadas}\n` +
    `Desconectadas: ${SESIONES_ACTIVAS.size - conectadas}`
  );
});

// Comando /agregar — agregar sesión nueva
bot.command('agregar', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  
  const nombre = ctx.match || `Sesion_${SESIONES_ACTIVAS.size + 1}`;
  const authDir = path.join(__dirname, `auth_${nombre}`);
  
  const sesion = new SesionWhatsApp(nombre, authDir);
  SESIONES_ACTIVAS.set(nombre, sesion);
  await sesion.iniciar();
  
  await ctx.reply(`✅ Sesión "${nombre}" agregada. Esperando conexión...`);
  console.log(`➕ Sesión "${nombre}" agregada`);
});

// Manejo de errores del bot
bot.catch((err) => {
  console.error('❌ Error en bot de Telegram:', err);
});

// ──────────────────────────────────────────────
// INICIALIZACIÓN
// ──────────────────────────────────────────────
async function configurarSesionesIniciales() {
  // === CONFIGURA TUS SESIONES INICIALES AQUÍ ===
  const sesionesConfig = [
    { nombre: 'Cuenta_1', authDir: './auth_cuenta1' },
    // Agrega más aquí:
    // { nombre: 'Cuenta_2', authDir: './auth_cuenta2' },
    // ... hasta 70+ sin problema
  ];

  for (const cfg of sesionesConfig) {
    const sesion = new SesionWhatsApp(cfg.nombre, cfg.authDir);
    SESIONES_ACTIVAS.set(cfg.nombre, sesion);
    await sesion.iniciar();
    await delay(1000);
  }
  
  console.log(`🔧 ${SESIONES_ACTIVAS.size} sesiones configuradas`);
}

async function iniciarTodo() {
  console.log('🤖 Iniciando Bot...');
  
  // Iniciar servidor web
  iniciarServidorWeb();
  
  // Configurar sesiones de WhatsApp
  await configurarSesionesIniciales();
  
  // Iniciar bot de Telegram
  await bot.start({
    onStart: (info) => {
      console.log(`🤖 Bot de Telegram conectado como @${info.username}`);
    }
  });
}

// ─── ARRANQUE FINAL ───
iniciarTodo().catch(err => {
  console.error('❌ Error al iniciar:', err);
  process.exit(1);
});
