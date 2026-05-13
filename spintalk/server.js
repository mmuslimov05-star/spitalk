/**
 * SPINTALK — Node.js Backend Server
 * Технологии: Express + Socket.io + WebRTC signaling
 * 
 * Установка: npm install
 * Запуск:    node server.js
 * Продакшн:  pm2 start server.js --name spintalk
 */

'use strict';

const express     = require('express');
const http        = require('http');
const { Server }  = require('socket.io');
const path        = require('path');
const rateLimit   = require('express-rate-limit');
const helmet      = require('helmet');
const cors        = require('cors');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.ORIGIN || '*', methods: ['GET', 'POST'] },
  pingTimeout: 30000,
  pingInterval: 15000,
});

// ── CONFIG ──────────────────────────────────────
const PORT    = process.env.PORT || 3000;
const SECRET  = process.env.ADMIN_SECRET || 'change-me-in-production';

// ── MIDDLEWARE ──────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// Rate limiter — 100 req/15min per IP
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true }));

// ── IN-MEMORY STATE ─────────────────────────────
/**
 * waitingQueue: Map<mode, Socket[]>
 *   mode: 'video' | 'text'
 * activePairs: Map<socketId, { partner: socketId, mode, startedAt, msgs }>
 * bannedIPs:   Map<ip, { until, reason }>
 * reports:     Array<{ from, against, type, ts }>
 * stats:       Object
 */
const waitingQueue  = new Map([['video', []], ['text', []]]);
const activePairs   = new Map();
const bannedIPs     = new Map();
const reports       = [];
const adminSockets  = new Set();

const stats = {
  totalChats:    0,
  activeChats:   0,
  connectedUsers: 0,
  chatsToday:    0,
  lastReset:     new Date().toDateString(),
};

// ── HELPERS ─────────────────────────────────────
function resetDailyStats() {
  const today = new Date().toDateString();
  if (stats.lastReset !== today) {
    stats.chatsToday = 0;
    stats.lastReset  = today;
  }
}

function getClientIP(socket) {
  return socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || socket.handshake.address;
}

function isBanned(ip) {
  if (!bannedIPs.has(ip)) return false;
  const ban = bannedIPs.get(ip);
  if (ban.until && Date.now() > ban.until) {
    bannedIPs.delete(ip);
    return false;
  }
  return true;
}

function broadcastAdminStats() {
  const payload = {
    online:     stats.connectedUsers,
    activeChats: stats.activeChats,
    chatsToday: stats.chatsToday,
    totalChats: stats.totalChats,
    queueVideo: waitingQueue.get('video').length,
    queueText:  waitingQueue.get('text').length,
  };
  adminSockets.forEach(s => s.emit('admin:stats', payload));
}

function logEvent(type, data) {
  const entry = { type, ts: new Date().toISOString(), ...data };
  console.log(`[${type.toUpperCase()}]`, JSON.stringify(data));
  adminSockets.forEach(s => s.emit('admin:log', entry));
}

// ── MATCHING ENGINE ─────────────────────────────
function tryMatch(socket, mode, interests) {
  const queue = waitingQueue.get(mode);

  // Look for interest overlap first
  let bestIdx   = -1;
  let bestScore = -1;
  for (let i = 0; i < queue.length; i++) {
    const candidate = queue[i];
    if (!candidate.connected) continue;
    const common = (candidate.interests || []).filter(t => interests.includes(t)).length;
    if (common > bestScore) { bestScore = common; bestIdx = i; }
  }

  // Fallback: first in queue
  if (bestIdx === -1 && queue.length > 0) bestIdx = 0;

  if (bestIdx !== -1) {
    const partner = queue.splice(bestIdx, 1)[0];
    pairSockets(socket, partner, mode);
  } else {
    queue.push(socket);
    socket.emit('status', { state: 'waiting', position: queue.length });
    logEvent('queue', { id: socket.id, mode, queueLen: queue.length });
  }
}

function pairSockets(s1, s2, mode) {
  const chatId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now    = Date.now();

  activePairs.set(s1.id, { partner: s2.id, mode, startedAt: now, msgs: 0, chatId });
  activePairs.set(s2.id, { partner: s1.id, mode, startedAt: now, msgs: 0, chatId });

  s1.partner = s2;
  s2.partner = s1;

  // The caller sends WebRTC offer
  s1.emit('matched', { role: 'caller',  mode, chatId });
  s2.emit('matched', { role: 'callee',  mode, chatId });

  stats.totalChats++;
  stats.chatsToday++;
  stats.activeChats++;
  resetDailyStats();

  logEvent('match', { chatId, mode, s1: s1.id, s2: s2.id });
  broadcastAdminStats();
}

function unpairSocket(socket, reason = 'disconnect') {
  const pair = activePairs.get(socket.id);
  if (!pair) return;

  const partner = socket.partner;
  if (partner && partner.connected) {
    partner.emit('partner:left', { reason });
    partner.partner = null;
    activePairs.delete(partner.id);
  }

  // Record duration
  const duration = Math.floor((Date.now() - pair.startedAt) / 1000);
  logEvent('end', { chatId: pair.chatId, duration, msgs: pair.msgs, reason });

  activePairs.delete(socket.id);
  stats.activeChats = Math.max(0, stats.activeChats - 1);
  broadcastAdminStats();
}

function removeFromQueue(socket) {
  ['video', 'text'].forEach(mode => {
    const q = waitingQueue.get(mode);
    const idx = q.indexOf(socket);
    if (idx !== -1) q.splice(idx, 1);
  });
}

// ── SOCKET.IO EVENTS ────────────────────────────
io.on('connection', (socket) => {
  const ip = getClientIP(socket);

  // Ban check
  if (isBanned(ip)) {
    socket.emit('banned', { reason: bannedIPs.get(ip)?.reason || 'Нарушение правил' });
    socket.disconnect(true);
    return;
  }

  stats.connectedUsers++;
  logEvent('join', { id: socket.id, ip: ip.replace(/\.\d+$/, '.x') });
  broadcastAdminStats();

  // ── Client wants to find a chat ──
  socket.on('find', ({ mode = 'video', interests = [] }) => {
    if (!['video', 'text'].includes(mode)) return;
    if (activePairs.has(socket.id)) {
      unpairSocket(socket, 'skip');
    }
    socket.interests = interests;
    tryMatch(socket, mode, interests);
  });

  // ── Skip / find next ──
  socket.on('skip', () => {
    removeFromQueue(socket);
    unpairSocket(socket, 'skip');
    const mode = activePairs.get(socket.id)?.mode || 'video';
    tryMatch(socket, mode, socket.interests || []);
  });

  // ── WebRTC signaling ──
  socket.on('signal', (data) => {
    const partner = socket.partner;
    if (partner && partner.connected) {
      partner.emit('signal', data);
    }
  });

  // ── Chat messages ──
  socket.on('message', ({ text }) => {
    if (typeof text !== 'string' || text.length > 500) return;
    const pair = activePairs.get(socket.id);
    if (!pair) return;

    // Stop-word filter (basic)
    const clean = sanitizeMessage(text);

    const partner = socket.partner;
    if (partner && partner.connected) {
      partner.emit('message', { text: clean, ts: Date.now() });
    }
    pair.msgs++;
  });

  // ── Report ──
  socket.on('report', ({ type, description }) => {
    const pair = activePairs.get(socket.id);
    const against = pair?.partner || null;
    const report = {
      id:          `rep_${Date.now()}`,
      from:        socket.id,
      against:     against,
      againstIP:   socket.partner ? getClientIP(socket.partner) : null,
      type:        type || 'Неприемлемый контент',
      description: description?.slice(0, 500) || '',
      ts:          new Date().toISOString(),
      status:      'pending',
    };
    reports.push(report);
    socket.emit('report:ack');
    logEvent('report', { type: report.type, from: socket.id });

    // Auto-ban if too many reports against this user
    if (against) {
      const reportCount = reports.filter(r => r.against === against).length;
      if (reportCount >= 3) {
        const partnerIP = report.againstIP;
        if (partnerIP) {
          bannedIPs.set(partnerIP, { reason: 'Авто-бан: 3+ жалобы', until: null });
          io.to(against).emit('banned', { reason: 'Авто-бан по жалобам' });
          logEvent('auto_ban', { ip: partnerIP });
        }
      }
    }

    adminSockets.forEach(s => s.emit('admin:report', report));
  });

  // ── Admin connection ──
  socket.on('admin:auth', ({ secret }) => {
    if (secret !== SECRET) {
      socket.emit('admin:auth:fail');
      return;
    }
    adminSockets.add(socket);
    socket.emit('admin:auth:ok');
    broadcastAdminStats();
    socket.emit('admin:data', {
      reports: reports.slice(-50),
      bans: [...bannedIPs.entries()].map(([ip, b]) => ({ ip, ...b })),
    });
  });

  socket.on('admin:ban', ({ ip, reason, durationMs }) => {
    if (!adminSockets.has(socket)) return;
    const until = durationMs ? Date.now() + durationMs : null;
    bannedIPs.set(ip, { reason: reason || 'Ручной бан', until });
    logEvent('ban', { ip, reason, until });
    socket.emit('admin:ban:ok', { ip });
  });

  socket.on('admin:unban', ({ ip }) => {
    if (!adminSockets.has(socket)) return;
    bannedIPs.delete(ip);
    logEvent('unban', { ip });
  });

  socket.on('admin:terminate', ({ chatId }) => {
    if (!adminSockets.has(socket)) return;
    for (const [sid, pair] of activePairs) {
      if (pair.chatId === chatId) {
        const s = io.sockets.sockets.get(sid);
        if (s) { s.emit('terminated', { reason: 'Модератор завершил чат' }); unpairSocket(s, 'admin'); }
      }
    }
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    removeFromQueue(socket);
    unpairSocket(socket, 'disconnect');
    adminSockets.delete(socket);
    stats.connectedUsers = Math.max(0, stats.connectedUsers - 1);
    logEvent('leave', { id: socket.id });
    broadcastAdminStats();
  });
});

// ── REST API ─────────────────────────────────────
app.get('/api/stats', (req, res) => {
  resetDailyStats();
  res.json({
    online:     stats.connectedUsers,
    activeChats: stats.activeChats,
    chatsToday: stats.chatsToday,
    totalChats: stats.totalChats,
  });
});

// ── STOP-WORD FILTER ─────────────────────────────
const stopWords = new Set(['casino','spam','scam','18+','pornhub','click here']);

function sanitizeMessage(text) {
  let out = text.trim();
  for (const word of stopWords) {
    const re = new RegExp(word, 'gi');
    out = out.replace(re, '***');
  }
  return out;
}

// ── START ────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n✅ SpinTalk server running on http://localhost:${PORT}`);
  console.log(`   Admin panel: http://localhost:${PORT}/admin/`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  io.emit('server:shutdown', { message: 'Сервер перезапускается. Попробуйте снова через минуту.' });
  server.close(() => process.exit(0));
});

module.exports = { app, server, io };
