/**
 * lanChat - Frontend Logic
 */
'use strict';

const state = {
  username: '',
  currentRoom: 'General',
  socket: null,
  typingTimer: null,
  isTyping: false,
  typingUsers: new Set(),
  isConnected: false,
  loadingOlder: false,
  hasMoreMessages: true,
  oldestMessageId: null,
};

const ROOM_DESCS = {
  General: 'General conversation for everyone',
  Help: 'Get technical support and assistance',
  Random: 'Anything and everything else',
};

const $ = (id) => document.getElementById(id);
const $all = (sel) => document.querySelectorAll(sel);

const nameModal = $('name-modal');
const nameInput = $('name-input');
const nameSubmit = $('name-submit');
const nameError = $('name-error');
const msgArea = $('messages-area');
const msgInput = $('msg-input');
const sendBtn = $('send-btn');
const typingEl = $('typing-indicator');
const usersList = $('users-list');
const onlineCount = $('online-count');
const themeToggle = $('theme-toggle');
const emojiBtn = $('emoji-btn');
const emojiTray = $('emoji-tray');
const attachBtn = $('attach-btn');
const fileInput = $('file-input');
const lightbox = $('lightbox');
const lightboxImg = $('lightbox-img');
const topbarRoom = $('topbar-room');
const topbarDesc = $('topbar-desc');
const mobileMenuBtn = $('mobile-menu-btn');
const roomsSidebar = $('rooms-sidebar');
const userAvatar = $('user-avatar');
const userName = $('user-name');
const usersToggleBtn = $('users-toggle-btn');
const usersSidebar = $('users-sidebar');
const mobileSidebarBackdrop = $('mobile-sidebar-backdrop');

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  checkAuth();
  setupEventListeners();
  handleViewportChange();
});

function initTheme() {
  const saved = localStorage.getItem('lc_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  setThemeToggleIcon(saved === 'dark' ? '☀️' : '🌙');
}

function checkAuth() {
  const saved = localStorage.getItem('lc_username');
  if (saved) {
    state.username = saved;
    nameModal.style.display = 'none';
    enterChat();
  } else {
    nameModal.style.display = 'flex';
    nameInput.focus();
    nameInput.select();
  }
}

function enterChat() {
  userName.textContent = state.username;
  userAvatar.textContent = state.username.charAt(0).toUpperCase();
  userAvatar.style.backgroundColor = getUserColor(state.username);
  initSocket();
  loadMessages(state.currentRoom);
}

function updateConnectionStatus(connected = state.isConnected) {
  const statusEl = $('connection-status');
  if (statusEl) {
    statusEl.classList.toggle('connected', connected);
    statusEl.classList.toggle('disconnected', !connected);
    statusEl.title = connected ? 'Connected' : 'Disconnected - Reconnecting...';
  }
}

function showToast(message, type = 'info') {
  const container = $('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 100);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function initSocket() {
  if (typeof io === 'undefined') {
    showToast('Socket.io not loaded. Refresh page.', 'error');
    return;
  }
  state.socket = io({
    transports: ['websocket'],
    timeout: 5000,
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
  });

  state.socket.on('connect', () => {
    state.isConnected = true;
    updateConnectionStatus(true);
    showToast('Connected!', 'success');
    state.socket.emit('join', { username: state.username, room: state.currentRoom });
  });

  state.socket.on('disconnect', () => {
    state.isConnected = false;
    updateConnectionStatus(false);
    showToast('Disconnected. Reconnecting...', 'info');
  });

  state.socket.on('connect_error', (err) => {
    showToast(`Connection failed: ${err.message || err}`, 'error');
  });

  state.socket.on('error', (data) => {
    showToast(data.message || 'Error occurred', 'error');
  });

  state.socket.on('new_message', (msg) => {
    appendMessage(msg);
    if (state.oldestMessageId === null || msg.id < state.oldestMessageId) {
      state.oldestMessageId = msg.id;
    }
    if (isAtBottom()) scrollToBottom();
  });

  state.socket.on('message_deleted', ({ msg_id }) => {
    const el = document.querySelector(`[data-id="${msg_id}"]`);
    if (el) el.remove();
  });

  state.socket.on('user_list', ({ room, users }) => {
    if (room === state.currentRoom) renderUserList(users);
  });

  state.socket.on('user_typing', ({ username }) => {
    if (username !== state.username) {
      state.typingUsers.add(username);
      updateTypingIndicator();
    }
  });

  state.socket.on('user_stop_typing', ({ username }) => {
    state.typingUsers.delete(username);
    updateTypingIndicator();
  });

  state.socket.on('reactions_update', ({ msg_id, reactions }) => {
    const container = document.querySelector(`[data-id="${msg_id}"] .msg-reactions`);
    if (container) renderReactions(container, msg_id, reactions);
  });

  state.socket.on('system_msg', ({ text }) => {
    appendSystemMessage(text);
  });

  updateConnectionStatus();
}

async function loadMessages(room, beforeId = null) {
  try {
    const url = `/messages/${encodeURIComponent(room)}` + (beforeId ? `?before=${beforeId}&limit=50` : '?limit=50');
    const res = await fetch(url);
    if (!res.ok) throw new Error(await res.text());
    const msgs = await res.json();
    state.hasMoreMessages = msgs.length === 50;

    if (!beforeId) {
      msgArea.innerHTML = '';
      state.oldestMessageId = null;
    }

    const fragment = document.createDocumentFragment();
    msgs.forEach((m) => {
      const div = buildMessageNode(m, m.user === state.username);
      if (state.oldestMessageId === null || m.id < state.oldestMessageId) {
        state.oldestMessageId = m.id;
      }
      fragment.appendChild(div);
    });

    if (beforeId) {
      msgArea.insertBefore(fragment, msgArea.firstChild);
    } else {
      msgArea.appendChild(fragment);
    }

    if (!beforeId) scrollToBottom(false);
  } catch (err) {
    console.error('Failed to load messages:', err);
    showToast(`Failed to load messages: ${err.message}`, 'error');
  }
}

function buildMessageNode(msg, isOwn) {
  const div = document.createElement('div');
  div.className = `msg-group ${isOwn ? 'mine' : ''}`;
  div.dataset.id = msg.id;

  const color = getUserColor(msg.user);
  div.innerHTML = `
    <div class="msg-avatar" style="background-color: ${color}">${msg.user.charAt(0).toUpperCase()}</div>
    <div class="msg-content">
      <div class="msg-meta">
        <span class="msg-username" style="color: ${color}">${msg.user}</span>
        <span class="msg-time">${msg.time}</span>
      </div>
      <div class="msg-text">${escapeHTML(msg.text)}</div>
      ${msg.file_url ? renderFile(msg.file_url, msg.file_name) : ''}
      <div class="msg-reactions"></div>
    </div>
    <div class="msg-actions">
      <button class="action-btn" onclick="showReactionPicker(${msg.id}, this)">React</button>
      ${isOwn ? `<button class="action-btn danger" onclick="deleteMessage(${msg.id})">Delete</button>` : ''}
    </div>
  `;

  renderReactions(div.querySelector('.msg-reactions'), msg.id, msg.reactions || {});
  return div;
}

function appendMessage(msg) {
  msgArea.appendChild(buildMessageNode(msg, msg.user === state.username));
}

function renderFile(url, name) {
  const isImg = /\.(png|jpe?g|gif|webp)$/i.test(url);
  if (isImg) {
    return `<div class="msg-file"><img src="${url}" alt="${name}" onclick="viewImage('${url}')"></div>`;
  }
  return `<div class="msg-file"><a href="${url}" class="file-link" target="_blank" rel="noopener noreferrer">File ${escapeHTML(name)}</a></div>`;
}

function renderReactions(container, msgId, reactions) {
  container.innerHTML = '';
  Object.entries(reactions).forEach(([emoji, users]) => {
    const isMine = users.includes(state.username);
    const pill = document.createElement('div');
    pill.className = `reaction-pill ${isMine ? 'mine' : ''}`;
    pill.innerHTML = `<span>${emoji}</span> <span class="count">${users.length}</span>`;
    pill.title = users.join(', ');
    pill.onclick = () => toggleReaction(msgId, emoji, isMine);
    container.appendChild(pill);
  });
}

async function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !state.socket) return;

  state.socket.emit('send_message', {
    username: state.username,
    room: state.currentRoom,
    text
  });

  msgInput.value = '';
  msgInput.style.height = 'auto';
  stopTyping();
}

async function deleteMessage(id) {
  if (!confirm('Delete this message?')) return;
  try {
    await fetch(`/delete/${id}?username=${encodeURIComponent(state.username)}`, { method: 'DELETE' });
  } catch (err) {
    console.error('Delete failed:', err);
  }
}

async function toggleReaction(msgId, emoji, isMine) {
  const endpoint = isMine ? 'unreact' : 'react';
  try {
    await fetch(`/${endpoint}/${msgId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: state.username, emoji })
    });
  } catch (err) {
    console.error('Reaction toggle failed:', err);
  }
}

function showReactionPicker(msgId, btn) {
  const emojis = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '💯'];
  const tray = document.createElement('div');
  tray.className = 'emoji-tray picker';
  emojis.forEach((emoji) => {
    const button = document.createElement('button');
    button.className = 'emoji-btn';
    button.textContent = emoji;
    button.onclick = () => {
      toggleReaction(msgId, emoji, false);
      tray.remove();
    };
    tray.appendChild(button);
  });

  const rect = btn.getBoundingClientRect();
  tray.style.position = 'fixed';
  if (rect.top > 160) {
    tray.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  } else {
    tray.style.top = `${rect.bottom + 6}px`;
  }
  tray.style.left = `${Math.min(rect.left, window.innerWidth - 210)}px`;
  document.body.appendChild(tray);

  const close = (e) => {
    if (!tray.contains(e.target) && e.target !== btn) {
      tray.remove();
      document.removeEventListener('mousedown', close);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 10);
}

function setupEventListeners() {
  nameSubmit.onclick = handleNameSubmit;
  nameInput.onkeydown = (e) => e.key === 'Enter' && handleNameSubmit();

  sendBtn.onclick = sendMessage;
  msgInput.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  msgInput.oninput = () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = `${msgInput.scrollHeight}px`;
    handleTyping();
  };

  msgArea.addEventListener('scroll', () => {
    if (msgArea.scrollTop <= 5 && state.hasMoreMessages && !state.loadingOlder && state.isConnected) {
      loadMoreMessages();
    }
  });

  $all('.room-item').forEach((item) => {
    item.onclick = () => switchRoom(item.dataset.room);
  });

  themeToggle.onclick = toggleTheme;
  mobileMenuBtn.onclick = () => toggleSidebar('rooms');
  usersToggleBtn.onclick = () => toggleSidebar('users');

  attachBtn.onclick = () => fileInput.click();
  fileInput.onchange = handleFileUpload;

  emojiBtn.onclick = (e) => {
    e.stopPropagation();
    emojiTray.hidden = !emojiTray.hidden;
  };

  $all('.emoji-btn').forEach((btn) => {
    btn.onclick = () => {
      msgInput.value += btn.dataset.emoji;
      msgInput.focus();
      emojiTray.hidden = true;
    };
  });

  document.addEventListener('click', (e) => {
    if (!emojiTray.contains(e.target) && e.target !== emojiBtn) {
      emojiTray.hidden = true;
    }
  });

  mobileSidebarBackdrop.onclick = closeSidebars;
  window.addEventListener('resize', handleViewportChange);
}

function handleNameSubmit() {
  const val = nameInput.value.trim();
  if (val.length < 2) {
    nameError.textContent = 'Name too short';
    return;
  }
  state.username = val;
  localStorage.setItem('lc_username', val);
  nameModal.style.display = 'none';
  enterChat();
}

async function loadMoreMessages() {
  if (state.loadingOlder || !state.oldestMessageId) return;
  state.loadingOlder = true;
  $('loading-more').style.display = 'flex';
  const prevScrollHeight = msgArea.scrollHeight;
  await loadMessages(state.currentRoom, state.oldestMessageId);
  state.loadingOlder = false;
  $('loading-more').style.display = 'none';
  msgArea.scrollTop = msgArea.scrollHeight - prevScrollHeight;
}

function switchRoom(room) {
  if (room === state.currentRoom) return;

  if (state.socket) {
    state.socket.emit('leave', { username: state.username, room: state.currentRoom });
  }
  state.currentRoom = room;
  state.hasMoreMessages = true;
  state.oldestMessageId = null;
  state.typingUsers.clear();
  updateTypingIndicator();

  $all('.room-item').forEach((item) => {
    const isActive = item.dataset.room === room;
    item.classList.toggle('active', isActive);
    item.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  topbarRoom.textContent = room;
  topbarDesc.textContent = ROOM_DESCS[room] || '';
  closeSidebars();

  if (state.socket) {
    state.socket.emit('join', { username: state.username, room: state.currentRoom });
  }
  loadMessages(room);
}

function handleTyping() {
  if (!state.isTyping && state.socket) {
    state.isTyping = true;
    state.socket.emit('typing', { username: state.username, room: state.currentRoom });
  }
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(stopTyping, 2000);
}

function stopTyping() {
  if (state.isTyping && state.socket) {
    state.isTyping = false;
    state.socket.emit('stop_typing', { username: state.username, room: state.currentRoom });
  }
}

function updateTypingIndicator() {
  const users = Array.from(state.typingUsers);
  if (users.length === 0) {
    typingEl.textContent = '';
  } else if (users.length === 1) {
    typingEl.textContent = `${users[0]} is typing...`;
  } else if (users.length === 2) {
    typingEl.textContent = `${users[0]} and ${users[1]} are typing...`;
  } else {
    typingEl.textContent = `${users[0]} and ${users.length - 1} others are typing...`;
  }
}

function renderUserList(users) {
  onlineCount.textContent = users.length;
  usersList.innerHTML = users.map((u) => `
    <div class="user-entry">
      <div class="status-dot"></div>
      <span>${escapeHTML(u)}</span>
    </div>
  `).join('');
}

async function handleFileUpload() {
  const file = fileInput.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.url) {
      state.socket.emit('send_message', {
        username: state.username,
        room: state.currentRoom,
        text: '',
        file_url: data.url,
        file_name: data.name
      });
    }
  } catch (err) {
    console.error('Upload failed:', err);
  }
  fileInput.value = '';
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('lc_theme', next);
  setThemeToggleIcon(next === 'dark' ? '☀️' : '🌙');
}

function setThemeToggleIcon(icon) {
  let iconEl = themeToggle.querySelector('[aria-hidden="true"]');
  if (!iconEl) {
    iconEl = document.createElement('span');
    iconEl.setAttribute('aria-hidden', 'true');
    themeToggle.appendChild(iconEl);
  }
  iconEl.textContent = icon;
}

function scrollToBottom(smooth = true) {
  msgArea.scrollTo({ top: msgArea.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function isAtBottom() {
  return msgArea.scrollHeight - msgArea.scrollTop - msgArea.clientHeight < 100;
}

function appendSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'system-msg';
  div.textContent = text;
  msgArea.appendChild(div);
}

function viewImage(url) {
  lightboxImg.src = url;
  lightbox.style.display = 'flex';
  lightbox.onclick = () => {
    lightbox.style.display = 'none';
  };
}

function toggleSidebar(target) {
  if (window.innerWidth > 980) {
    if (target === 'users') {
      usersSidebar.classList.toggle('hidden');
    }
    return;
  }

  const openRooms = roomsSidebar.classList.contains('open');
  const openUsers = usersSidebar.classList.contains('open');

  if (target === 'rooms') {
    roomsSidebar.classList.toggle('open', !openRooms);
    usersSidebar.classList.remove('open');
  }

  if (target === 'users') {
    usersSidebar.classList.toggle('open', !openUsers);
    roomsSidebar.classList.remove('open');
  }

  syncBackdrop();
}

function closeSidebars() {
  roomsSidebar.classList.remove('open');
  usersSidebar.classList.remove('open');
  syncBackdrop();
}

function syncBackdrop() {
  const show = window.innerWidth <= 980 &&
    (roomsSidebar.classList.contains('open') || usersSidebar.classList.contains('open'));
  mobileSidebarBackdrop.hidden = !show;
}

function handleViewportChange() {
  if (window.innerWidth > 980) {
    mobileSidebarBackdrop.hidden = true;
    roomsSidebar.classList.remove('open');
    usersSidebar.classList.remove('open');
  } else {
    usersSidebar.classList.remove('hidden');
    syncBackdrop();
  }
}

function getUserColor(str) {
  const colors = ['#f87171', '#fb923c', '#facc15', '#4ade80', '#2dd4bf', '#38bdf8', '#60a5fa', '#818cf8', '#a78bfa', '#f472b6'];
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function escapeHTML(str = '') {
  const p = document.createElement('p');
  p.textContent = str;
  return p.innerHTML;
}
