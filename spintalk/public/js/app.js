/* =============================================
   SPINTALK — Frontend Application Logic
   Handles UI, simulated matching, WebRTC hooks
   ============================================= */

'use strict';

// ── STATE ─────────────────────────────────────
const state = {
  chatMode: null,           // 'video' | 'text'
  connected: false,
  chatStartTime: null,
  timerInterval: null,
  localStream: null,
  peerConnection: null,
  socket: null,
  interests: [],
  camEnabled: true,
  micEnabled: true,
  searchTimeout: null,
  sessionId: generateId(),
  messageCount: 0,
};

// ── INIT ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  animateCounters();
  startOnlineCounter();
  setupTagInput();
  loadDevices();
  loadTheme();

  // Simulate live online count
  setInterval(() => {
    const base = 4291;
    const variation = Math.floor((Math.random() - 0.5) * 40);
    const count = base + variation;
    const el1 = document.getElementById('online-count');
    const el2 = document.getElementById('stat-online');
    if (el1) el1.textContent = count.toLocaleString('ru-RU');
    if (el2) el2.textContent = count.toLocaleString('ru-RU');
  }, 5000);
});

// ── PAGE NAVIGATION ───────────────────────────
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById(pageId);
  if (target) target.classList.add('active');
}

function goHome() {
  stopChat();
  showPage('landing-page');
}

// ── CHAT INIT ─────────────────────────────────
async function startChat(mode) {
  const ageCheck = document.getElementById('age-check');
  if (!ageCheck || !ageCheck.checked) {
    showToast('⚠️ Подтвердите возраст, чтобы продолжить');
    ageCheck?.parentElement?.closest('.age-confirm')?.classList.add('shake');
    setTimeout(() => {
      ageCheck?.parentElement?.closest('.age-confirm')?.classList.remove('shake');
    }, 500);
    return;
  }

  state.chatMode = mode;

  const layout = document.getElementById('chat-layout');
  if (mode === 'text') {
    layout.classList.add('text-mode');
  } else {
    layout.classList.remove('text-mode');
    await initCamera();
  }

  showPage('chat-page');
  clearMessages();
  beginSearch();
}

// ── CAMERA / MIC ──────────────────────────────
async function initCamera() {
  try {
    const constraints = {
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: true
    };
    state.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    const localVideo = document.getElementById('local-video');
    if (localVideo) localVideo.srcObject = state.localStream;
  } catch (err) {
    console.warn('Camera access denied or unavailable:', err);
    showToast('📷 Камера недоступна — продолжаем без видео');
  }
}

function toggleCamera() {
  if (!state.localStream) return;
  const tracks = state.localStream.getVideoTracks();
  state.camEnabled = !state.camEnabled;
  tracks.forEach(t => t.enabled = state.camEnabled);
  const btn = document.getElementById('btn-cam');
  if (btn) {
    btn.textContent = state.camEnabled ? '📷' : '🚫';
    btn.classList.toggle('muted', !state.camEnabled);
  }
}

function toggleMic() {
  if (!state.localStream) return;
  const tracks = state.localStream.getAudioTracks();
  state.micEnabled = !state.micEnabled;
  tracks.forEach(t => t.enabled = state.micEnabled);
  const btn = document.getElementById('btn-mic');
  if (btn) {
    btn.textContent = state.micEnabled ? '🎤' : '🔇';
    btn.classList.toggle('muted', !state.micEnabled);
  }
}

async function loadDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const camSel = document.getElementById('camera-select');
    const micSel = document.getElementById('mic-select');
    if (!camSel || !micSel) return;

    devices.filter(d => d.kind === 'videoinput').forEach((d, i) => {
      camSel.add(new Option(d.label || `Камера ${i + 1}`, d.deviceId));
    });
    devices.filter(d => d.kind === 'audioinput').forEach((d, i) => {
      micSel.add(new Option(d.label || `Микрофон ${i + 1}`, d.deviceId));
    });
  } catch (e) { /* permissions not yet granted */ }
}

// ── SEARCH LOGIC ──────────────────────────────
function beginSearch() {
  setStatus('searching', 'Поиск собеседника...');
  hidePlaceholder(false);
  stopTimer();
  disableReport(true);

  document.getElementById('btn-report').disabled = true;

  // Simulate finding a partner (in production: Socket.IO signaling)
  const delay = 1500 + Math.random() * 3000;
  state.searchTimeout = setTimeout(() => {
    connectPartner();
  }, delay);
}

function connectPartner() {
  state.connected = true;
  state.chatStartTime = Date.now();

  const countries = ['🇷🇺', '🇩🇪', '🇺🇸', '🇫🇷', '🇮🇹', '🇧🇷', '🇺🇦', '🇵🇱', '🇸🇪', '🇨🇦'];
  const country = countries[Math.floor(Math.random() * countries.length)];

  setStatus('connected', 'Собеседник найден');
  hidePlaceholder(true);
  showStrangerBadge(country);
  startTimer();
  disableReport(false);

  addSystemMessage('Собеседник подключился. Привет! 👋');

  // Random auto-message simulation
  if (Math.random() > 0.5) {
    setTimeout(() => {
      receiveMessage(getRandomGreeting());
    }, 2000 + Math.random() * 3000);
  }
}

function skipPartner() {
  if (state.searchTimeout) clearTimeout(state.searchTimeout);
  disconnectPartner(false);
  clearMessages();
  setTimeout(() => beginSearch(), 300);
}

function stopChat() {
  if (state.searchTimeout) clearTimeout(state.searchTimeout);
  disconnectPartner(true);
  stopTimer();
  stopStream();
}

function disconnectPartner(full = false) {
  state.connected = false;
  stopTimer();
  disableReport(true);
  hidePlaceholder(false);
  hideStrangerBadge();
  setStatus('searching', full ? 'Отключено' : 'Ищем нового...');

  if (!full) {
    addSystemMessage('Собеседник отключился. Ищем следующего...');
  }
}

function stopStream() {
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
  }
  const localVideo = document.getElementById('local-video');
  if (localVideo) localVideo.srcObject = null;
}

// ── MESSAGING ─────────────────────────────────
function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input?.value?.trim();
  if (!text || !state.connected) return;

  addMessage(text, 'own');
  input.value = '';
  state.messageCount++;

  // Simulate occasional reply
  if (Math.random() > 0.3 && state.connected) {
    setTimeout(() => {
      if (state.connected) receiveMessage(getSmartReply(text));
    }, 800 + Math.random() * 2000);
  }
}

function receiveMessage(text) {
  addMessage(text, 'stranger');
}

function addMessage(text, side) {
  const wrap = document.getElementById('messages-wrap');
  if (!wrap) return;

  const div = document.createElement('div');
  div.className = `message ${side}`;
  const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `
    <div class="message-bubble">${escapeHtml(text)}</div>
    <div class="message-time">${time}</div>
  `;
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

function addSystemMessage(text) {
  const wrap = document.getElementById('messages-wrap');
  if (!wrap) return;
  const div = document.createElement('div');
  div.className = 'system-msg';
  div.textContent = text;
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

function clearMessages() {
  const wrap = document.getElementById('messages-wrap');
  if (wrap) wrap.innerHTML = '';
}

function handleMsgKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

// ── STATUS / UI HELPERS ───────────────────────
function setStatus(type, text) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-text');
  if (dot) { dot.className = `status-dot ${type}`; }
  if (label) label.textContent = text;
}

function hidePlaceholder(hide) {
  const ph = document.getElementById('remote-placeholder');
  if (ph) ph.style.display = hide ? 'none' : 'flex';
}

function showStrangerBadge(flag) {
  const badge = document.getElementById('stranger-badge');
  const flagEl = document.getElementById('stranger-country');
  if (badge) badge.style.display = 'flex';
  if (flagEl) flagEl.textContent = flag;
}

function hideStrangerBadge() {
  const badge = document.getElementById('stranger-badge');
  if (badge) badge.style.display = 'none';
}

function disableReport(disabled) {
  const btn = document.getElementById('btn-report');
  if (btn) btn.disabled = disabled;
}

// ── TIMER ─────────────────────────────────────
function startTimer() {
  stopTimer();
  state.chatStartTime = Date.now();
  state.timerInterval = setInterval(updateTimer, 1000);
}

function stopTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  const el = document.getElementById('chat-timer');
  if (el) el.textContent = '00:00';
}

function updateTimer() {
  if (!state.chatStartTime) return;
  const elapsed = Math.floor((Date.now() - state.chatStartTime) / 1000);
  const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  const el = document.getElementById('chat-timer');
  if (el) el.textContent = `${m}:${s}`;
}

// ── TOAST ─────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ── SETTINGS ─────────────────────────────────
function toggleSettings() {
  const panel = document.getElementById('settings-panel');
  if (panel) panel.classList.toggle('open');
}

function changeTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('spintalk-theme', theme);
}

function loadTheme() {
  const saved = localStorage.getItem('spintalk-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  const sel = document.getElementById('theme-select');
  if (sel) sel.value = saved;
}

// ── INTERESTS / TAGS ─────────────────────────
function setupTagInput() {
  const input = document.getElementById('interest-input');
  if (!input) return;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = input.value.trim().replace(/,/g, '');
      if (val) addTag(val);
      input.value = '';
    }
    if (e.key === 'Backspace' && !input.value && state.interests.length) {
      removeTag(state.interests[state.interests.length - 1]);
    }
  });
}

function addTag(text) {
  if (state.interests.includes(text) || state.interests.length >= 8) return;
  state.interests.push(text);
  renderTags();
}

function addPresetTag(el) {
  const text = el.textContent.trim();
  if (state.interests.includes(text)) {
    removeTag(text);
  } else {
    addTag(text);
  }
}

function removeTag(text) {
  state.interests = state.interests.filter(t => t !== text);
  renderTags();
}

function renderTags() {
  const display = document.getElementById('tags-display');
  if (!display) return;
  display.innerHTML = state.interests.map(t =>
    `<span class="tag">${escapeHtml(t)}<em class="tag-remove" onclick="removeTag('${escapeHtml(t)}')">×</em></span>`
  ).join('');
}

// ── AGE / REPORT ──────────────────────────────
function checkAge() { /* Handled by DOM */ }

function confirmAge() {
  const modal = document.getElementById('age-modal');
  if (modal) modal.style.display = 'none';
  const ageCheck = document.getElementById('age-check');
  if (ageCheck) ageCheck.checked = true;
}

function denyAge() {
  window.location.href = 'https://www.google.com';
}

function reportUser() {
  showPage('report-page');
}

function submitReport() {
  showToast('✅ Жалоба отправлена. Спасибо!');
  setTimeout(() => showPage('chat-page'), 1500);
}

// ── COUNTER ANIMATION ─────────────────────────
function animateCounters() {
  const targets = {
    'stat-chats': 1284051,
    'stat-countries': 193,
    'stat-online': 4291,
  };
  Object.entries(targets).forEach(([id, target]) => {
    const el = document.getElementById(id);
    if (!el) return;
    let current = 0;
    const step = Math.ceil(target / 80);
    const interval = setInterval(() => {
      current = Math.min(current + step, target);
      el.textContent = current.toLocaleString('ru-RU');
      if (current >= target) clearInterval(interval);
    }, 16);
  });
}

function startOnlineCounter() {
  // Fluctuate online counter naturally
  setInterval(() => {
    const el = document.getElementById('stat-online');
    if (!el) return;
    const curr = parseInt(el.textContent.replace(/\s/g, '')) || 4291;
    const next = Math.max(3800, Math.min(5000, curr + Math.floor((Math.random() - 0.5) * 30)));
    el.textContent = next.toLocaleString('ru-RU');
  }, 4000);
}

// ── SMART REPLY SIMULATION ────────────────────
const greetings = ['Привет!', 'Хей!', 'Hello!', 'Хай)', 'Привет, как дела?', 'Salut!', 'Hi there!'];
const replies = [
  'Интересно!', 'Расскажи подробнее', 'Согласен 😄', 'Хм, не думал об этом',
  'Правда?)', 'А ты откуда?', 'Круто!', 'Да-да', 'Не знаю честно говоря',
  'А что ты любишь делать?', 'Ok', 'xD', 'lol', 'Понятно', 'Ого!'
];

function getRandomGreeting() { return greetings[Math.floor(Math.random() * greetings.length)]; }
function getSmartReply() { return replies[Math.floor(Math.random() * replies.length)]; }

// ── UTILS ─────────────────────────────────────
function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ── CSS SHAKE ANIMATION ───────────────────────
const shakeStyle = document.createElement('style');
shakeStyle.textContent = `
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20% { transform: translateX(-6px); }
    40% { transform: translateX(6px); }
    60% { transform: translateX(-4px); }
    80% { transform: translateX(4px); }
  }
  .shake { animation: shake 0.4s ease; }
`;
document.head.appendChild(shakeStyle);
