'use strict';

// ========== Utilities ==========
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const show = (el) => el && el.classList.remove('hidden');
const hide = (el) => el && el.classList.add('hidden');

// Role label mapping
const roleLabel = (r) => ({
  HQ: 'HQ',
  PROTECTOR: 'Protector',
  HEIR: 'Heir',
  OBSERVER: 'Observer',
}[r] || r || '');

let currentUser = { role: '', username: '', display_name: '' };
let currentDiplomacyDraft = { allies: [], rivals: [] };

// Token storage
const tokens = {
  get access() { return localStorage.getItem('abx_access') || ''; },
  set access(v) { localStorage.setItem('abx_access', v || ''); },
  get refresh() { return localStorage.getItem('abx_refresh') || ''; },
  set refresh(v) { localStorage.setItem('abx_refresh', v || ''); },
  clear() { localStorage.removeItem('abx_access'); localStorage.removeItem('abx_refresh'); }
};

let sessionInvalidated = false;



// Simple state store to persist view state across refreshes
const stateStore = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
  del(key) { try { localStorage.removeItem(key); } catch {} }
};

// Persist user info so a hard refresh keeps permissions/UI state
const userStore = {
  get() {
    return {
      role: localStorage.getItem('abx_role') || '',
      username: localStorage.getItem('abx_username') || '',
      display_name: localStorage.getItem('abx_display_name') || ''
    };
  },
  set(u) {
    if (!u) return;
    localStorage.setItem('abx_role', u.role || '');
    localStorage.setItem('abx_username', u.username || '');
    localStorage.setItem('abx_display_name', u.display_name || '');
  },
  clear() {
    localStorage.removeItem('abx_role');
    localStorage.removeItem('abx_username');
    localStorage.removeItem('abx_display_name');
  }
};

// API helper with auto-refresh
function decodeJwt(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));

    return JSON.parse(jsonPayload);
  } catch (e) {
    return null;
  }
}

async function api(path, opts = {}) {
  let accessToken = tokens.access;

  if (accessToken) {
    const decodedToken = decodeJwt(accessToken);
    // Check if token is expired or will expire in the next 60 seconds
    if (decodedToken && decodedToken.exp * 1000 < Date.now() + 60000) {
      if (!tokens.refresh) {
        handleUnauthorizedResponse();
        throw new Error("Session expired.");
      }
      try {
        const rf = await fetch('/api/auth/token/refresh/', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh: tokens.refresh })
        });
        if (!rf.ok) {
          handleUnauthorizedResponse();
          throw new Error("Session expired.");
        }
        const data = await rf.json();
        if (data.access) {
          tokens.access = data.access;
          accessToken = data.access;
        } else {
          handleUnauthorizedResponse();
          throw new Error("Session expired.");
        }
      } catch (error) {
        handleUnauthorizedResponse();
        throw error; // Re-throw the error to be caught by the caller
      }
    }
  }

  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  
  const res = await fetch(path, { ...opts, headers });

  if (res.status === 401) {
    // The initial proactive refresh might have failed, or another issue occurred.
    // We can keep the original retry logic as a fallback.
    if (!tokens.refresh) {
      handleUnauthorizedResponse();
      return res;
    }
    try {
      const rf = await fetch('/api/auth/token/refresh/', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh: tokens.refresh })
      });
      if (!rf.ok) {
        handleUnauthorizedResponse();
        return res;
      }
      const data = await rf.json();
      if (data.access) {
        tokens.access = data.access;
        const headers2 = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
        headers2['Authorization'] = `Bearer ${tokens.access}`;
        const retry = await fetch(path, { ...opts, headers: headers2 });
        if (retry.status === 401) handleUnauthorizedResponse();
        return retry;
      } else {
        handleUnauthorizedResponse();
        return res;
      }
    } catch (error) {
      handleUnauthorizedResponse();
      return res;
    }
  }

  return res;
}

function handleUnauthorizedResponse(message = 'Session expired. Please log in again.') {
  if (sessionInvalidated) return;
  sessionInvalidated = true;
  tokens.clear();
  userStore.clear();
  currentUser = { role: '', username: '', display_name: '' };
  stateStore.del('abx_tier');
  stateStore.del('abx_page');
  stateStore.del('abx_profile_id');
  stateStore.del('abx_index_filters');
  invalidateFactionDirectory();
  try { closeModal(); } catch {}
  try { hide(qs('#shutdown-overlay')); } catch {}
  switchTier('login');
  try { showMessage(message, 'error'); } catch {}
  setTimeout(() => { sessionInvalidated = false; }, 1500);
}

// Simple HTML escape for dynamic strings
const escapeHtml = (str = '') => String(str)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// Function to add role-specific navigation items
function setupNavigation() {
  const navContainer = qs('#abacus-main-nav');
  if (!navContainer) return;

  // Avoid duplicating nav items
  if (qs('[data-page="index"]', navContainer)) return;

  const isLeadership = ['HQ', 'PROTECTOR', 'HEIR'].includes(currentUser.role);

  const navItems = [
    {
      group: 'Primary',
      items: [
        { page: 'pulse', label: 'The Pulse', icon: '<path d="M10.25 4.75a.75.75 0 00-1.5 0v4.573a2.504 2.504 0 00-1.24-1.032.75.75 0 00-.52 1.398 3.998 3.998 0 012.51 3.811V15.25a.75.75 0 001.5 0v-1.75a.75.75 0 00-1.5 0v.237a2.5 2.5 0 00-2.08-2.432.75.75 0 00-.42 1.45 1 1 0 01.8 1.185v2.513a.75.75 0 001.5 0v-2.25a.75.75 0 00-1.5 0v.237a2.5 2.5 0 00-2.08-2.432.75.75 0 00-.42 1.45 1 1 0 01.8 1.185v2.513a.75.75 0 001.5 0V15.25a.75.75 0 001.5 0v-1.75a.75.75 0 00-1.5 0v.237a2.5 2.5 0 00-2.08-2.432.75.75 0 00-.42 1.45 1 1 0 01.8 1.185v2.513a.75.75 0 001.5 0V9.323a3.998 3.998 0 012.51-3.811.75.75 0 00-.52-1.398A2.504 2.504 0 0010.25 5.35V4.75z" />', access: 'all' },
        { page: 'index', label: 'The Index', icon: '<path d="M10 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.465 14.493a1.23 1.23 0 0 0 .41 1.412A9.957 9.957 0 0 0 10 18c2.31 0 4.438-.784 6.131-2.095a1.23 1.23 0 0 0 .41-1.412A9.992 9.992 0 0 0 10 12c-2.31 0-4.438.784-6.131 2.095Z" />', access: 'all' },
        { page: 'scales', label: 'The Scales', icon: '<path fill-rule="evenodd" d="M17.707 3.293a1 1 0 0 1 0 1.414L11.414 11l6.293 6.293a1 1 0 0 1-1.414 1.414L10 12.414l-6.293 6.293a1 1 0 0 1-1.414-1.414L8.586 11 2.293 4.707a1 1 0 0 1 1.414-1.414L10 9.586l6.293-6.293a1 1 0 0 1 1.414 0Z" clip-rule="evenodd" />', access: 'all' },
        { page: 'lineage', label: 'The Lineage', icon: '<path fill-rule="evenodd" d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z" clip-rule="evenodd" />', access: 'all' },
      ]
    },
    {
      group: 'Operations',
      items: [
        { page: 'loom', label: 'The Loom', icon: '<path d="M15.901 16.543a1.23 1.23 0 00-1.231-1.045 9.958 9.958 0 01-9.34 0 1.23 1.23 0 00-1.231 1.045 9.992 9.992 0 0011.802 0zM10 3a3 3 0 100 6 3 3 0 000-6z" />', access: 'leadership' },
        { page: 'silo', label: 'The Silo', icon: '<path fill-rule="evenodd" d="M1.75 4.5a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 .75.75v8.5a.75.75 0 0 1-.75.75H2.5a.75.75 0 0 1-.75-.75V4.5Zm3.25 2a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 .75.75v.5a.75.75 0 0 1-1.5 0v-.5H6.5v.5a.75.75 0 0 1-1.5 0v-.5Zm-2 4.5a.75.75 0 0 1 .75-.75h12.5a.75.75 0 0 1 .75.75v.5a.75.75 0 0 1-1.5 0v-.5h-11v.5a.75.75 0 0 1-1.5 0v-.5Z" clip-rule="evenodd" />', access: 'all' },
      ]
    },
    {
      group: 'Knowledge',
      items: [
        { page: 'codex', label: 'The Codex', icon: '<path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />', access: 'all' },
        { page: 'vault', label: 'The Vault', icon: '<path fill-rule="evenodd" d="M6 3.75A2.75 2.75 0 0 1 8.75 1h2.5A2.75 2.75 0 0 1 14 3.75v.443c.57.259 1.07.644 1.5 1.11v-1.553A4.25 4.25 0 0 0 11.25-.5h-2.5A4.25 4.25 0 0 0 4.5 3.75v1.553c.43-.466.93-.851 1.5-1.11V3.75Zm8.5 3c-1.022 0-1.954.3-2.75.812V6.567a.75.75 0 0 0-1.5 0v1.188A5.5 5.5 0 0 0 10 8.5c-.347 0-.686.034-1.018.1V6.567a.75.75 0 0 0-1.5 0v1.994A4.25 4.25 0 0 0 3 12.75v3.5A2.75 2.75 0 0 0 5.75 19h8.5A2.75 2.75 0 0 0 17 16.25v-3.5A4.25 4.25 0 0 0 14.5 8.5c-.347 0-.686.034-1.018.1V6.75c.796-.512 1.728-.812 2.768-.812a2.75 2.75 0 0 1 2.75 2.75v.25a.75.75 0 0 0 1.5 0v-.25A4.25 4.25 0 0 0 14.5 6.75Z" clip-rule="evenodd" />', access: 'leadership' },
      ]
    }
  ];

  let navHtml = '';
  for (const group of navItems) {
    const groupButtons = group.items
      .filter(item => {
        if (item.access === 'leadership') return isLeadership;
        return true; // 'all'
      })
      .map(item => `
        <button class="nav-item" data-action="navigate" data-page="${item.page}">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-5 h-5">${item.icon}</svg>
            <span>${item.label}</span>
        </button>
      `).join('');

    if (groupButtons) {
      navHtml += `<div class="nav-group">${groupButtons}</div>`;
    }
  }

  navContainer.insertAdjacentHTML('afterbegin', navHtml);
}


const sectionBlock = (title, content) => `
  <div class="panel rounded-lg">
    <h3 class="text-base font-semibold text-gray-200 px-4 py-2 border-b border-gray-800">${title}</h3>
    <div class="p-4">${content}</div>
  </div>
`;

const sectionInput = (id, value, rows = 3, placeholder = '', extraClasses = '') => `
  <textarea id="${id}"
    class="w-full px-3 py-2 rounded bg-gray-900 border border-gray-800 text-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-700 ${extraClasses}"
    rows="${rows}"
    placeholder="${placeholder}">${escapeHtml(value)}</textarea>
`;

  const formatTimestamp = (ts) => {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return String(ts);
  }
};

const resolveFactionName = (value = '') => {
  const name = String(value || '').trim();
  if (!name) return '';
  const exact = factionDirectoryCache.byName?.get?.(name);
  if (exact && exact.name) return exact.name;
  const list = factionDirectoryCache.list || [];
  const lower = name.toLowerCase();
  for (const item of list) {
    const label = String(item?.name || '');
    if (label.toLowerCase() === lower) return label;
  }
  return name;
};

let factionDirectoryCache = {
  list: [],
  byName: new Map(),
  byId: new Map(),
  timestamp: 0
};

async function getFactionDirectory(force = false) {
  const now = Date.now();
  if (!force && factionDirectoryCache.list.length && (now - factionDirectoryCache.timestamp) < 60000) {
    return factionDirectoryCache;
  }
  const res = await api('/api/scales/factions/');
  if (!res.ok) throw new Error(`Failed to fetch faction directory (${res.status})`);
  const list = await res.json();
  const byName = new Map();
  const byId = new Map();
  list.forEach((item) => {
    if (!item || !item.name) return;
    byName.set(item.name, item);
    byId.set(String(item.id), item);
  });
  factionDirectoryCache = { list, byName, byId, timestamp: now };
  return factionDirectoryCache;
}

function invalidateFactionDirectory() {
  factionDirectoryCache = { list: [], byName: new Map(), byId: new Map(), timestamp: 0 };
}

function switchTier(tier) {
  const t1 = qs('#tier-1-facade');
  const t2 = qs('#tier-2-login');
  const t3 = qs('#tier-3-abacus');
  if (tier === 'facade') { show(t1); hide(t2); hide(t3); }
  else if (tier === 'login') { hide(t1); show(t2); hide(t3); }
  else if (tier === 'abacus') { hide(t1); hide(t2); show(t3); }
  stateStore.set('abx_tier', tier);
}

function showFacadePage(page) {
  qsa('[id^="facade-page-"]').forEach((p) => hide(p));
  show(qs(`#facade-page-${page}`));
}

function openModal(contentHtml) {
  const modal = qs('#abacus-modal');
  const content = qs('#modal-content');
  if (content) content.innerHTML = contentHtml || '';
  show(modal);
}
function closeModal() { hide(qs('#abacus-modal')); }

function openConfirmModal(title, message, onConfirm, confirmText = 'Confirm', confirmClass = 'red') {
  const html = `
    <div class="cy-panel rounded-lg overflow-hidden" style="min-width: 420px;">
      <div class="modal-title py-3 border-b border-gray-800 bg-gray-950/70">
        <div class="text-lg font-semibold text-gray-100 tracking-wide mono px-4">» ${escapeHtml(title)}</div>
      </div>
      <div class="modal-body p-4 bg-gray-950/40">
        <p class="text-sm text-gray-300 mono">${escapeHtml(message)}</p>
      </div>
      <footer class="py-3 border-t border-gray-800 bg-gray-950/70 flex justify-end gap-3 px-4">
        <button data-action="close-modal" class="terminal-btn abort">// ABORT</button> 
        <button id="modal-confirm-btn" class="terminal-btn commit ${confirmClass}">${`// ${confirmText.toUpperCase()}`}</button>
      </footer>
    </div>`;
  openModal(html);

  qs('#modal-confirm-btn').addEventListener('click', () => {
    if (typeof onConfirm === 'function') {
      onConfirm();
    }
    closeModal();
  }, { once: true });
}

function showMessage(msg, type = 'info') {
  const mc = qs('#message-container');
  if (!mc) return;
  const el = document.createElement('div');
  el.className = `abacus-message message-${type}`;
  el.textContent = msg;
  mc.appendChild(el);
  // Fade out before removing
  setTimeout(() => {
    el.style.opacity = '0';
    el.addEventListener('transitionend', () => el.remove());
  }, 3000);
}

function handleNavigation(page) {
  const area = qs('#abacus-content-area');
  if (!area) return;
  area.innerHTML = `
    <div class="space-y-2">
      <h2 class="text-xl font-bold text-gray-100 capitalize">${page}</h2>
      <p class="text-gray-400">Content for "${page}" goes here.</p>
    </div>`;
}

async function login(username, password) {
  const res = await fetch('/api/auth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Authentication failed');
  }
  const data = await res.json();
  // simplejwt returns access/refresh; backend adds role, username
  tokens.access = data.access || '';
  tokens.refresh = data.refresh || '';
  return data;
}

function logout() { tokens.clear(); }

window.addEventListener('DOMContentLoaded', () => {
  showFacadePage('home');

  // Hidden trigger: click the keyhole dot to reveal login
  const keyhole = qs('#keyhole');
  if (keyhole) keyhole.addEventListener('click', () => switchTier('login'));

  // Login form → authenticate via JWT
  const loginForm = qs('#login-form');
  const loginError = qs('#login-error');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = qs('#username')?.value?.trim();
      const passphrase = qs('#passphrase')?.value?.trim();
      if (!username || !passphrase) {
        if (loginError) { loginError.textContent = 'Please enter username and passphrase.'; show(loginError); }
        return;
      }
      try {
        if (loginError) hide(loginError);
        const data = await login(username, passphrase);
        currentUser = { role: data.role || '', username: data.username || '', display_name: data.display_name || '' };
        userStore.set(currentUser);
        const r = roleLabel(currentUser.role);
        switchTier('abacus');
        setupNavigation(); // Add nav items after successful login
        showMessage(`Welcome, ${currentUser.display_name || username} (${r}).`, 'info');
      } catch (err) {
        if (loginError) { loginError.textContent = err.message; show(loginError); }
      }
    });
  }

  // Extra safety: wire facade nav buttons directly (in addition to global delegation)
  const facadeNav = qs('#facade-nav');
  if (facadeNav) {
    facadeNav.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="navigate-facade"]');
      if (!btn) return;
      e.preventDefault();
      const page = btn.getAttribute('data-page') || 'home';
      switchTier('facade');
      showFacadePage(page);
    });
  }

  // Global click delegation
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.getAttribute('data-action');
    if (!action) return;

    switch (action) {
      case 'navigate-facade': {
        const page = target.getAttribute('data-page') || 'home';
        // Ensure we are on the facade tier and then switch sections
        switchTier('facade');
        showFacadePage(page);
        break;
      }
      case 'back-to-facade': {
        switchTier('facade');
        break;
      }
      case 'navigate': {
        const page = target.getAttribute('data-page') || 'dashboard';
        stateStore.set('abx_page', page);
        stateStore.del('abx_profile_id');
        handleNavigation(page);
        break;
      }
      case 'open-notifications': {
        openModal('<div class="text-gray-200">No new notifications.</div>');
        break;
      }
      case 'close-modal': {
        closeModal();
        break;
      }
      case 'logout': {
        logout();
        userStore.clear();
        currentUser = { role: '', username: '', display_name: '' };
        stateStore.del('abx_tier');
        stateStore.del('abx_page');
        stateStore.del('abx_profile_id');
        stateStore.del('abx_index_filters');
        switchTier('facade');
        closeModal();
        hide(qs('#shutdown-overlay'));
        showMessage('Logged out.');
        break;
      }
      case 'panic': {
        show(qs('#shutdown-overlay'));
        break;
      }
      case 'zoom-image': {
        const imageUrl = target.getAttribute('data-url');
        if (imageUrl) {
          openModal(`<img src="${escapeHtml(imageUrl)}" class="max-w-full max-h-[80vh] rounded-lg shadow-lg">`);
        }
        break;
      }
      default: break;
    }
  });

  // Escape to close modal/overlay
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); hide(qs('#shutdown-overlay')); }
  });

  // If tokens exist, restore user and last view without relog
  if (tokens.access) {
    const u = userStore.get();
    if (u && (u.role || u.username || u.display_name)) currentUser = u;
    const savedTier = stateStore.get('abx_tier', 'abacus');
    setupNavigation(); // Ensure nav is set up on restore
    switchTier(savedTier);
    if (savedTier === 'abacus') {
      const savedPage = stateStore.get('abx_page', 'dashboard');
      // Restore index detail or list
      if (savedPage === 'index') {
        const pid = stateStore.get('abx_profile_id', '');
        if (pid) {
          openIndexDetail(pid);
        } else {
          loadIndexList(indexFilters).then(renderIndexList).catch(e=>showMessage('Failed to load Index','error'));
        }
      } else {
        handleNavigation(savedPage);
      }
    }
  }
});

// ===== Terminal-style Block Caret for inline edits =====
(function initBlockCaret() {
  let caretEl = null;
  const ensure = () => {
    if (!caretEl) {
      caretEl = document.createElement('div');
      caretEl.id = 'block-caret';
      caretEl.style.position = 'absolute';
      caretEl.style.background = '#22c55e';
      caretEl.style.opacity = '0.9';
      caretEl.style.pointerEvents = 'none';
      caretEl.style.zIndex = '9999';
      caretEl.style.display = 'none';
      caretEl.style.width = '0.6em';
      caretEl.style.height = '1em';
      caretEl.style.mixBlendMode = 'screen';
      document.body.appendChild(caretEl);
    }
  };

  const hide = () => { if (caretEl) caretEl.style.display = 'none'; };

  const update = () => {
    ensure();
    const active = document.activeElement;
    if (!active || !active.classList || !active.classList.contains('term-edit')) { hide(); return; }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { hide(); return; }
    try {
      const r = sel.getRangeAt(0).cloneRange();
      r.collapse(true);
      const rects = r.getClientRects();
      const rect = rects[0];
      const s = getComputedStyle(active);
      const lh = parseFloat(s.lineHeight) || (parseFloat(s.fontSize) * 1.2) || 16;
      if (!rect) { hide(); return; }
      caretEl.style.width = '0.6em';
      caretEl.style.height = lh + 'px';
      caretEl.style.left = (rect.left + window.scrollX) + 'px';
      caretEl.style.top = (rect.top + window.scrollY) + 'px';
      caretEl.style.display = 'block';
    } catch { hide(); }
  };

  document.addEventListener('focusin', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('term-edit')) update();
  });
  document.addEventListener('focusout', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('term-edit')) hide();
  });
  ['keyup','mouseup','input','selectionchange'].forEach(evt =>
    document.addEventListener(evt, () => update())
  );
})();

// Handle view/back actions separately to ensure delegation catches them
document.addEventListener('click', async (e) => {
  const viewBtn = e.target.closest('[data-action="idx-view"]');
  if (viewBtn) {
    const id = viewBtn.getAttribute('data-id');
    if (id) openIndexDetail(id);
    return;
  }
  const backBtn = e.target.closest('[data-action="idx-back"]');
  if (backBtn) {
    try {
      const data = await loadIndexList(indexFilters);
      renderIndexList(data);
    } catch (err) { showMessage(err.message || 'Failed to load Index', 'error'); }
    stateStore.set('abx_page','index');
    stateStore.del('abx_profile_id');
  }
  const qaBtn = e.target.closest('[data-action="idx-actions"]');
  if (qaBtn) {
    const menu = qs('#idx-actions-menu');
    if (menu) menu.classList.toggle('hidden');
    return;
  }
  const connDel = e.target.closest('[data-action="idx-conn-del"]');
  if (connDel) {
    const cid = connDel.getAttribute('data-cid');
    const pid = connDel.getAttribute('data-id');
    if (cid && confirm('Remove this connection?')) {
      const r = await api(`/api/index/profiles/${pid}/connections/?id=${encodeURIComponent(cid)}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 204) { showMessage('Failed to remove', 'error'); return; }
      openIndexDetail(pid);
    }
    return;
  }
  const connAdd = e.target.closest('[data-action="idx-conn-add"]');
  if (connAdd) {
    const pid = connAdd.getAttribute('data-id');
    openAddConnectionModal(pid);
    return;
  }
  const openFaction = e.target.closest('[data-action="open-faction"]');
  if (openFaction) {
    const fid = openFaction.getAttribute('data-id');
    if (fid) {
      try {
        const r = await api(`/api/scales/factions/${fid}/`);
        if (r.ok) {
          const f = await r.json();
          openModal(`<div class=\"text-gray-200\"><div class=\"text-lg font-bold mb-2\">${f.name}</div><div>Threat Index: ${f.threat_index ?? '—'}</div><div>Members: ${f.member_count ?? '—'}</div></div>`);
        }
      } catch {}
    }
    return;
  }
  const qaReport = e.target.closest('[data-action="qa-file-report"]');
  if (qaReport) {
    const pid = qaReport.getAttribute('data-id');
    openModal(`<div class=\"text-gray-200\">File New Report for profile ID ${pid}. (Coming soon)</div>`);
    return;
  }
  const qaOp = e.target.closest('[data-action="qa-add-to-op"]');
  if (qaOp) {
    const pid = qaOp.getAttribute('data-id');
    openModal(`<div class=\"text-gray-200\">Add profile ID ${pid} to an operation. (Coming soon)</div>`);
    return;
  }
  const editBtn = e.target.closest('[data-action="idx-inline-edit"]');
  if (editBtn) {
    const id = editBtn.getAttribute('data-id');
    const res = await api(`/api/index/profiles/${id}/`);
    if (!res.ok) { showMessage(`Load failed (${res.status})`, 'error'); return; }
    const item = await res.json();
    renderIndexDetailEdit(item);
    return;
  }
  const cancelBtn = e.target.closest('[data-action="idx-inline-cancel"]');
  if (cancelBtn) {
    const id = cancelBtn.getAttribute('data-id');
    openIndexDetail(id);
    return;
  }
  const saveBtn = e.target.closest('[data-action="idx-inline-save"]');
  if (saveBtn) {
    const id = saveBtn.getAttribute('data-id');
    const payload = {};

    const currentName = qs('#f_name2')?.value?.trim();
    payload.full_name = currentName || '';

    const currentPicUrl = qs('#f_pic')?.value?.trim();
    payload.picture_url = currentPicUrl || '';

    const currentCls = qs('#f_classification2')?.value;
    payload.classification = currentCls || '';

    const currentSt = qs('#f_status2')?.value;
    payload.status = currentSt || '';

    const currentTh = qs('#f_threat2')?.value;
    payload.threat_level = currentTh || '';

    const currentBio = qs('#f_bio2')?.value?.trim();
    payload.biography = currentBio || ''; // This should be an empty string

    const currentStr = qs('#f_str2')?.value?.trim();
    payload.strengths = currentStr || ''; // This should be an empty string

    const currentWeak = qs('#f_weak2')?.value?.trim();
    payload.weaknesses = currentWeak || '';

    // Convert comma-separated strings from inputs back to a single string for the TextField
    payload.aliases = parseDelimitedList(qs('#f_aliases2')?.value).join(', ');

    payload.known_locations = parseDelimitedList(qs('#f_locs2')?.value).join(', ');

    payload.known_vehicles = parseDelimitedList(qs('#f_veh2')?.value).join(', ');

    payload.surveillance_urls = parseDelimitedList(qs('#f_files2')?.value).join(', ');

    console.log(payload);
    const res = await api(`/api/index/profiles/${id}/`, { method: 'PATCH', body: JSON.stringify(payload) });
    openIndexDetail(id);
    return;
  }
});

document.addEventListener('click', async (e) => {
  const connDel = e.target.closest('[data-action="idx-conn-del"]');
  if (connDel) {
    const connectionId = connDel.getAttribute('data-cid');
    const profileId = connDel.getAttribute('data-pid');
    openConfirmModal('Confirm Removal', 'Are you sure you want to remove this connection?', async () => {
      const res = await api(`/api/index/profiles/${profileId}/connections/${connectionId}/`, { method: 'DELETE' });
      if (res.ok || res.status === 204) openIndexDetail(profileId); // Reload to show changes
      else showMessage('Failed to remove connection.', 'error');
    }, 'Remove', 'red');
  }
});

// ===== The Index UI =====
const ENUMS = {
  classification: {
    'ASSET_TALON': 'Asset (Talon)',
    'CRIMINAL_AFFILIATED': 'Criminal (Affiliated)',
    'CRIMINAL_UNAFFILIATED': 'Criminal (Unaffiliated)',
    'LAW_ENFORCEMENT': 'Law Enforcement',
    'GOVERNMENT_DOJ': 'Government / DOJ',
    'CIVILIAN_HIGH': 'Civilian (High Value)'
  },
  status: ['Active','Deceased','Incarcerated','Missing'],
  threat: ['None','Low','Medium','High','Critical']
};

let indexFilters = stateStore.get('abx_index_filters', { q: '', classification: '', status: '', threat_level: '' });
let currentIndexProfile = null;
let originalEditableProfileData = null;

const CLASS_LABELS = {
  ASSET_TALON: 'Asset (Talon)',
  CRIMINAL_AFFILIATED: 'Criminal (Affiliated)',
  CRIMINAL_UNAFFILIATED: 'Criminal (Unaffiliated)',
  LAW_ENFORCEMENT: 'Law Enforcement',
  GOVERNMENT_DOJ: 'Government / DOJ',
  CIVILIAN_HIGH: 'Civilian (High Value)',
  CIVILIAN_LOW: 'Civilian (Low Value)'
};

const STATUS_LABELS = {
  ACTIVE: 'Active',
  DECEASED: 'Deceased',
  INCARCERATED: 'Incarcerated',
  MISSING: 'Missing'
};

const THREAT_LABELS = {
  NONE: 'None',
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical'
};

async function loadIndexList(params = {}) {
  const usp = new URLSearchParams();
  if (params.q) usp.set('q', params.q);
  if (params.classification) usp.set('classification', params.classification);
  if (params.status) usp.set('status', params.status);
  if (params.threat_level) usp.set('threat_level', params.threat_level);
  if (params.affiliation_id) usp.set('affiliation_id', params.affiliation_id);
  const res = await api(`/api/index/profiles/${usp.toString() ? `?${usp.toString()}` : ''}`);
  if (!res.ok) throw new Error(`Failed to load Index (${res.status})`);
  return res.json();
}

function renderIndexScaffoldIfNeeded() {
  const area = qs('#abacus-content-area');
  if (!area) return;
  if (qs('#idx-tbody')) return; // already built
  const canEdit = ['HQ','PROTECTOR','HEIR','OBSERVER'].includes(currentUser.role);
  area.classList.add('lineage-bg');
  area.innerHTML = `
    <div class="mb-4 flex items-center justify-between gap-3">
      <h2 class="text-xl font-bold lineage-title tracking-widest">INDEX ROSTER</h2>
      <div class="flex items-center gap-3">
        <input id="idx-q" class="terminal-input w-64" placeholder="Search name/biography..." autocomplete="off" autocapitalize="none" spellcheck="false" />
        <select id="idx-class" class="terminal-input">
        <option value="">Classification</option>
        ${Object.entries(ENUMS.classification).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}
      </select>
        <select id="idx-status" class="terminal-input">
        <option value="">Status</option>
        ${Object.entries(STATUS_LABELS).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}
      </select>
        <select id="idx-threat" class="terminal-input">
        <option value="">Threat</option>
        ${Object.entries(THREAT_LABELS).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}
      </select>
        ${canEdit ? '<button id="idx-new" class="terminal-btn-outline text-sm">New Profile</button>' : ''}
      </div>
    </div>
    <div class="overflow-x-auto panel">
      <table class="min-w-full text-left text-sm">
        <thead class="text-gold-400">
          <tr>
            <th class="px-4 py-2">Name</th>
            <th class="px-4 py-2">Classification</th>
            <th class="px-4 py-2">Status</th>
            <th class="px-4 py-2">Threat</th>
            <th class="px-4 py-2">Aliases</th>
            <th class="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody id="idx-tbody" class="text-gray-200"></tbody>
      </table>
    </div>`;
  // wire once
  qs('#idx-q').addEventListener('input', debounceIndexSearch, { passive: true });
  qs('#idx-class').addEventListener('change', debounceIndexSearch);
  qs('#idx-status').addEventListener('change', debounceIndexSearch);
  qs('#idx-threat').addEventListener('change', debounceIndexSearch);
  const newBtn = qs('#idx-new');
  if (newBtn) newBtn.addEventListener('click', () => openIndexForm());
}

function renderIndexRows(items) {
  const canDelete = ['HQ','PROTECTOR','HEIR'].includes(currentUser.role);
  const canEdit = ['HQ','PROTECTOR','HEIR','OBSERVER'].includes(currentUser.role);
  const tbody = qs('#idx-tbody');
  if (!tbody) return;
  tbody.innerHTML = items.map(p=>`
    <tr class="border-t border-gray-800 hover:bg-gold-900/10">
      <td class="px-4 py-2 font-medium text-gray-100"><button class="text-left hover:underline" data-action="idx-view" data-id="${p.id}">${p.full_name}</button></td>
      <td class="px-4 py-2 text-gray-300">${p.classification||''}</td>
      <td class="px-4 py-2"><span class="inline-block px-2 py-0.5 rounded bg-gray-800 border border-gray-700 text-gray-300">${p.status||''}</span></td>
      <td class="px-4 py-2">${p.threat_level||''}</td>
      <td class="px-4 py-2 text-gray-400">${parseDelimitedList(p.aliases).join(', ')}</td>
      <td class="px-4 py-2 text-right space-x-2">
        ${canDelete ? `<button class="px-2 py-1 rounded bg-red-800 hover:bg-red-700 border border-red-700" data-action="idx-del" data-id="${p.id}">Delete</button>` : ''}
      </td>
    </tr>
  `).join('');
  // Re-apply filter input values (do not rebuild controls)
  const qInput = qs('#idx-q');
  const classSel = qs('#idx-class');
  const statusSel = qs('#idx-status');
  const threatSel = qs('#idx-threat');
  if (qInput && qInput !== document.activeElement) qInput.value = indexFilters.q || '';
  if (classSel) classSel.value = indexFilters.classification || '';
  if (statusSel) statusSel.value = indexFilters.status || '';
  if (threatSel) threatSel.value = indexFilters.threat_level || '';
}

function renderIndexList(items) {
  renderIndexScaffoldIfNeeded();
  renderIndexRows(items);
}

const formatChoice = (value, map) => {
  if (!value) return '—';
  if (map[value]) return map[value];
  const cleaned = String(value).replace(/_/g, ' ');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
};

const parseDelimitedList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  return String(value)
    .split(/[\n,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
};

const formatListMarkup = (items, emptyLabel = '// NO DATA') => {
  if (!items.length) {
    return `<div class="text-xs text-gray-500 mono">${emptyLabel}</div>`;
  }
  return `<ul class="space-y-1 text-sm text-gray-200 mono">${items.map((item) => `<li class="flex items-center gap-2"><span class="h-1.5 w-1.5 rounded-full bg-emerald-500/70"></span>${escapeHtml(item)}</li>`).join('')}</ul>`;
};

const multilineContent = (text, placeholder = '// NO DATA') => {
  const safe = escapeHtml(String(text || '')).replace(/\r?\n/g, '<br>');
  return safe || `<span class="text-xs text-gray-500 mono">${placeholder}</span>`;
};

function renderIndexDetailView(profile) {
  if (!profile) return;
  currentIndexProfile = profile;
  stateStore.set('abx_profile_id', profile.id);
  const area = qs('#abacus-content-area');
  if (!area) return;
  area.classList.add('lineage-bg');

  const canEdit = ['HQ','PROTECTOR','HEIR','OBSERVER'].includes(currentUser.role);
  const canDelete = ['HQ','PROTECTOR','HEIR'].includes(currentUser.role);

  const aliases = parseDelimitedList(profile.aliases);
  const locations = parseDelimitedList(profile.known_locations);
  const vehicles = parseDelimitedList(profile.known_vehicles);
  const surveillance = parseDelimitedList(profile.surveillance_urls);
  const affiliationList = Array.isArray(profile.affiliations) ? profile.affiliations : [];

  const classificationLabel = formatChoice(profile.classification, CLASS_LABELS);
  const statusLabel = formatChoice(profile.status, STATUS_LABELS);
  const threatLabel = formatChoice(profile.threat_level, THREAT_LABELS);

  const badgeClass = {
    NONE: 'border-gray-700 text-gray-300',
    LOW: 'border-emerald-700 text-emerald-300',
    MEDIUM: 'border-yellow-600 text-yellow-300',
    HIGH: 'border-orange-600 text-orange-300',
    CRITICAL: 'border-red-700 text-red-300'
  }[profile.threat_level] || 'border-gray-700 text-gray-300';

  const aliasMarkup = aliases.length
    ? `<div class="flex flex-wrap gap-2 text-sm text-gray-300 mono">${aliases.map((alias) => `<span class="px-2 py-0.5 border border-gray-700 rounded">${escapeHtml(alias)}</span>`).join('')}</div>`
    : `<span class="text-xs text-gray-500 mono">// NO ALIASES ON FILE</span>`;

  const affiliationMarkup = affiliationList.length
    ? affiliationList.map((aff) => {
        const label = escapeHtml(aff.name || aff.faction_name || aff.full_name || 'Unknown Faction');
        const id = aff.id || aff.faction_id;
        if (id) {
          return `<button class="px-2 py-1 text-xs border border-emerald-500/40 rounded hover:bg-emerald-500/10 mono" data-action="scales-view" data-id="${id}">${label}</button>`;
        }
        return `<span class="px-2 py-1 text-xs border border-gray-700 rounded mono">${label}</span>`;
      }).join(' ')
    : `<span class="text-xs text-gray-500 mono">// NO KNOWN AFFILIATIONS</span>`;

  const surveillanceMarkup = surveillance.length
    ? `<ul class="space-y-2 text-sm text-emerald-300 mono">${surveillance.map((url, idx) => `<li><a class="underline hover:text-emerald-200" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">File ${idx + 1}</a></li>`).join('')}</ul>`
    : `<span class="text-xs text-gray-500 mono">// NO SURVEILLANCE FILES</span>`;

  
  const connectionsMarkup = `
    <div class="space-y-3">
      <div id="idx-connections-list" class="cy-scroll-slab" style="max-height: 240px;"><div class="cy-spinner"></div></div>
      ${canEdit ? `<div class="mt-2"><button class="terminal-btn-outline text-xs" data-action="idx-conn-add" data-id="${profile.id}">+ Add Connection</button></div>` : ''}
    </div>
  `;

  area.innerHTML = `
    <div class="space-y-6 index-profile-view lineage-dossier">
      <div class="flex flex-wrap items-start justify-between gap-3 cypher-header pb-4">
        <div class="flex-1 space-y-2">
            <h2 class="text-xl font-bold lineage-title tracking-widest truncate">
              <button data-action="idx-back" class="breadcrumb-link">INDEX ROSTER</button>
              <span class="breadcrumb-sep">/</span>
              <span class="text-white">DOSSIER: ${escapeHtml(profile.full_name)}</span>
            </h2>
            <div class="flex flex-wrap items-center gap-2">
              <span class="inline-flex items-center gap-2 px-3 py-1 border rounded-full mono ${badgeClass}">
                  <span class="inline-block h-2 w-2 rounded-full ${threatDotClass(profile.threat_level)}"></span>${threatLabel}
              </span>
              <span class="inline-flex items-center gap-2 px-3 py-1 border rounded-full mono border-gray-700 text-gray-300">${classificationLabel}</span>
              <span class="inline-flex items-center gap-2 px-3 py-1 border rounded-full mono border-gray-700 text-gray-300">${statusLabel}</span>
            </div>
        </div>
        <div class="flex items-center gap-2">
          ${canEdit ? `<button class="terminal-btn-outline" data-action="idx-inline-edit" data-id="${profile.id}">EDIT</button>` : ''}
          ${canDelete ? `<button class="terminal-btn-outline" data-action="idx-del" data-id="${profile.id}">DELETE</button>` : ''}
          <button class="terminal-btn-outline" data-action="idx-back">BACK</button>
        </div>
      </div>
      <hr class="page-divider mb-6">

      <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div class="space-y-4">
          <div>
            <h3 class="panel-title">» Biography</h3>
            <hr class="panel-divider my-2">
            <div class="text-sm text-gray-300 font-serif">${multilineContent(profile.biography, '// NO BIOGRAPHY')}</div>
          </div>
          <div>
            <h3 class="panel-title">» Strengths</h3>
            <hr class="panel-divider my-2">
            ${formatListMarkup(parseDelimitedList(profile.strengths), '// NO STRENGTHS DOCUMENTED')}
          </div>
          <div>
            <h3 class="panel-title">» Weaknesses</h3>
            <hr class="panel-divider my-2">
            ${formatListMarkup(parseDelimitedList(profile.weaknesses), '// NO WEAKNESSES DOCUMENTED')}
          </div>
          <div>
            <h3 class="panel-title">» Aliases</h3>
            <hr class="panel-divider my-2">
            ${aliasMarkup}
          </div>
        </div>
        <div class="space-y-4">
          <div>
            <h3 class="panel-title">» Affiliations</h3>
            <hr class="panel-divider my-2">
            <div class="flex flex-wrap gap-2">${affiliationMarkup}</div>
          </div>
          <div>
            <h3 class="panel-title">» Known Connections</h3>
            <hr class="panel-divider my-2">
            ${connectionsMarkup}
          </div>
          <div>
            <h3 class="panel-title">» Surveillance Files</h3>
            <hr class="panel-divider my-2">
            ${surveillanceMarkup}
          </div>
          <div>
            <h3 class="panel-title">» Profile History</h3>
            <hr class="panel-divider my-2">
            <div id="idx-history" class="text-sm text-gray-300 mono cy-scroll-slab h-48 history-feed"><div class="cy-spinner"></div></div>
          </div>
        </div>
      </div>
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
        ${sectionBlock('Known Locations', formatListMarkup(locations, '// NO LOCATIONS'))}
        ${sectionBlock('Known Vehicles', formatListMarkup(vehicles, '// NO VEHICLES'))}
      </div>
    </div>`;

  // Asynchronously load and render the profile history
  (async () => {
    try {
      const res = await api(`/api/index/profiles/${profile.id}/timeline/`);
      if (!res.ok) return;
      const items = await res.json();
      const box = qs('#idx-history');
      if (!box) return;

      if (!Array.isArray(items) || !items.length) {
        box.innerHTML = '<div class="history-empty text-gray-500">No recorded changes.</div>';
        return;
      }

      const historyHtml = items.map((it) => {
        const ts = formatTimestamp(it.timestamp);
        const role = (it.role || '').trim();
        const actor = (it.user || '').trim();
        const metaBits = [ts];
        if (role) metaBits.push(role);
        if (actor && actor.toLowerCase() !== role.toLowerCase()) metaBits.push(actor);
        const meta = metaBits.filter(Boolean).join(' | ');
        const body = escapeHtml(it.text || '');
        return `<div class="history-item"><div class="history-meta mono">${escapeHtml(meta)}</div><div class="history-text text-sm text-gray-300">${body}</div></div>`;
      }).join('');
      box.innerHTML = historyHtml;
    } catch {}
  })();

  // Asynchronously load and render connections
  (async () => {
    try {
      const res = await api(`/api/index/profiles/${profile.id}/connections/`);
      if (!res.ok) throw new Error('Failed to load connections');
      const connections = await res.json();
      const box = qs('#idx-connections-list');
      if (!box) return;

      if (!Array.isArray(connections) || !connections.length) {
        box.innerHTML = '<div class="text-xs text-gray-500 mono">// NO CONNECTIONS ON FILE</div>';
        return;
      }

      const connectionsHtml = connections.map(c => {
        // Determine which profile in the connection is the "other" one.
        const isFrom = String(c.from_profile) === String(profile.id);
        const otherProfile = isFrom ? c.to_profile_details : c.from_profile_details;
        return `
          <div class="history-item flex justify-between items-start">
            <div>
              <div class="font-semibold text-gray-100"><button class="text-left hover:underline" data-action="idx-view" data-id="${otherProfile.id}">${escapeHtml(otherProfile.full_name)}</button></div>
              <div class="text-xs text-gray-400">RELATIONSHIP: ${escapeHtml(c.relationship)}</div>
            </div>
            ${canEdit ? `<button class="roster-remove-btn text-xs" data-action="idx-conn-del" data-cid="${c.id}" data-pid="${profile.id}" title="Remove Connection">✕</button>` : ''}
          </div>
        `}).join('');
      box.innerHTML = connectionsHtml;
    } catch (e) {
      qs('#idx-connections-list').innerHTML = '<div class="text-xs text-red-500 mono">// FAILED TO LOAD CONNECTIONS</div>';
    }
  })();
}

function renderIndexDetailEdit(profile) {
  if (!profile) profile = currentIndexProfile;
  if (!profile) return;
  currentIndexProfile = profile;
  stateStore.set('abx_profile_id', profile.id);
  const area = qs('#abacus-content-area');
  if (!area) return;
  area.classList.add('lineage-bg');

  originalEditableProfileData = { ...profile }; // Store original profile data

  const pictureValue = (profile.picture_url || '').replace(/"/g, '&quot;');
  const aliasValue = parseDelimitedList(profile.aliases).join(', ');
  const locationValue = parseDelimitedList(profile.known_locations).join(', ');
  const vehicleValue = parseDelimitedList(profile.known_vehicles).join(', ');
  const strengthsValue = parseDelimitedList(profile.strengths).join(', ');
  const weaknessesValue = parseDelimitedList(profile.weaknesses).join(', ');
  const affiliationList = Array.isArray(profile.affiliations) ? profile.affiliations : [];

  const affiliationMarkup = affiliationList?.length
    ? affiliationList.map((aff) => {
        const label = escapeHtml(aff.name || aff.faction_name || aff.full_name || 'Unknown Faction');
        const id = aff.id || aff.faction_id;
        if (id) {
          return `<button class="px-2 py-1 text-xs border border-emerald-500/40 rounded hover:bg-emerald-500/10 mono" data-action="scales-view" data-id="${id}">${label}</button>`;
        }
        return `<span class="px-2 py-1 text-xs border border-gray-700 rounded mono">${label}</span>`;
      }).join(' ')
    : `<span class="text-xs text-gray-500 mono">// NO KNOWN AFFILIATIONS</span>`;
  const surveillanceValue = parseDelimitedList(profile.surveillance_urls || '').join(', ');

  const badgeClass = {
    NONE: 'border-gray-700 text-gray-300',
    LOW: 'border-emerald-700 text-emerald-300',
    MEDIUM: 'border-yellow-600 text-yellow-300',
    HIGH: 'border-orange-600 text-orange-300',
    CRITICAL: 'border-red-700 text-red-300'
  }[profile.threat_level] || 'border-gray-700 text-gray-300';

  const renderOptions = (map, current) => {
    const entries = Object.entries(map);
    const options = [];
    entries.forEach(([value, label]) => {
      options.push(`<option value="${value}" ${value === (current || '') ? 'selected' : ''}>${label}</option>`);
    });
    if (current && !map[current]) {
      options.push(`<option value="${current}" selected>${current}</option>`);
    }
    return options.join('');
  };

  area.innerHTML = `
    <div class="space-y-6 index-profile-view lineage-dossier edit-mode">
      <div class="flex flex-col lg:flex-row lg:items-start gap-4 cypher-header p-4 rounded-lg">
        <div class="flex-1 space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-wrap items-center gap-3">
              <input id="f_name2" class="terminal-input flex-1 min-w-[220px] text-2xl font-semibold text-gray-100 h1-glow cy-glitch" value="${(profile.full_name || '').replace(/"/g, '&quot;')}" placeholder="Full Name">
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <button class="terminal-btn commit" data-action="idx-inline-save" data-id="${profile.id}">// COMMIT</button>
              <button class="terminal-btn abort" data-action="idx-inline-cancel" data-id="${profile.id}">// ABORT</button>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <span class="inline-flex items-center gap-2 px-3 py-1 border rounded-full mono ${badgeClass}">${renderCustomSelect('f_threat2', THREAT_LABELS, profile.threat_level)}</span>
            <span class="inline-flex items-center gap-2 px-3 py-1 border rounded-full mono border-gray-700 text-gray-300">${renderCustomSelect('f_classification2', CLASS_LABELS, profile.classification)}</span>
            <span class="inline-flex items-center gap-2 px-3 py-1 border rounded-full mono border-gray-700 text-gray-300">${renderCustomSelect('f_status2', STATUS_LABELS, profile.status)}</span>
          </div>
        </div>
      </div>
      <hr class="page-divider mb-6">

      <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div class="space-y-6">
          <div>
            <h3 class="panel-title">» Biography</h3>
            <hr class="panel-divider my-2">
            ${sectionInput('f_bio2', profile.biography || '', 10, '', 'terminal-input cy-scroll-slab font-serif')}
          </div>
          <div>
            <h3 class="panel-title">» Weaknesses</h3>
            <hr class="panel-divider my-2">
            ${sectionInput('f_weak2', weaknessesValue, 3, 'Comma-separated weaknesses', 'terminal-input mono')}
          </div>
          <div>
            <h3 class="panel-title">» Aliases</h3>
            <hr class="panel-divider my-2">
            ${sectionInput('f_aliases2', aliasValue, 3, 'Comma-separated aliases', 'terminal-input mono')}
          </div>
        </div>
        <div class="space-y-6">
          <div>
            <h3 class="panel-title">» Strengths</h3>
            <hr class="panel-divider my-2">
            ${sectionInput('f_str2', strengthsValue, 3, 'Comma-separated strengths', 'terminal-input mono')}
          </div>
          <div>
            <h3 class="panel-title">» Affiliations</h3>
            <hr class="panel-divider my-2">
            <div class="flex flex-wrap gap-2">${affiliationMarkup}</div>
          </div>
          <div>
            <h3 class="panel-title">» Surveillance Files</h3>
            <hr class="panel-divider my-2">
            ${sectionInput('f_files2', surveillanceValue, 3, 'Comma-separated URLs', 'terminal-input mono')}
          </div>
        </div>
      </div>
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div>
          <h3 class="panel-title">» Known Locations</h3>
          <hr class="panel-divider my-2">
          ${sectionInput('f_locs2', locationValue, 3, 'Comma-separated locations', 'terminal-input mono')}
        </div>
        <div>
          <h3 class="panel-title">» Known Vehicles</h3>
          <hr class="panel-divider my-2">
          ${sectionInput('f_veh2', vehicleValue, 3, 'Comma-separated vehicles', 'terminal-input mono')}
        </div>
      </div>
    </div>`;
}

async function openIndexDetail(id) {
  if (!id) return;
  try {
    const res = await api(`/api/index/profiles/${id}/`);
    if (!res.ok) {
      showMessage(`Load failed (${res.status})`, 'error');
      return;
    }
    const profile = await res.json();
    stateStore.set('abx_page', 'index');
    stateStore.set('abx_profile_id', id);
    renderIndexDetailView(profile);
  } catch (err) {
    console.error(err);
    showMessage('Failed to load profile.', 'error');
  }
}

function openAddConnectionModal(profileId) {
  if (!profileId) return;
  const html = `
    <div class="cy-panel rounded-lg overflow-hidden" style="min-width: 640px;">
      <div class="modal-title py-3 border-b border-gray-800 bg-gray-950/70">
        <div class="text-lg font-semibold text-gray-100 tracking-wide mono px-4">» ADD CONNECTION</div>
      </div>
      <div class="modal-body p-4 bg-gray-950/40 space-y-3">
        <div class="space-y-1">
            <label class="block text-sm text-gray-400 mb-1">Search Target Profile</label>
            <input id="conn-search" class="terminal-input w-full" placeholder="Search The Index..." autocomplete="off">
            <div id="conn-results" class="cy-scroll-slab h-48 overflow-y-auto border border-gray-800 rounded bg-gray-900/50 mt-1"></div>
        </div>
        <div class="space-y-1">
            <label class="block text-sm text-gray-400 mb-1">Relationship</label>
            <input id="conn-relationship" class="terminal-input w-full" placeholder="e.g., Known Associate, Rival, Family">
        </div>
        <div id="conn-error" class="text-red-400 mono text-sm hidden"></div>
      </div>
      <footer class="py-3 border-t border-gray-800 bg-gray-950/70 flex justify-end gap-3 px-4">
        <button data-action="close-modal" class="terminal-btn abort">// CANCEL</button>
        <button id="conn-save" class="terminal-btn commit">// SAVE CONNECTION</button>
      </footer>
    </div>
  `;
  openModal(html);

  const searchInput = qs('#conn-search');
  const resultsContainer = qs('#conn-results');
  const relationshipInput = qs('#conn-relationship');
  const errorContainer = qs('#conn-error');
  const saveBtn = qs('#conn-save');
  let searchTimer = null;
  let selectedTargetId = null;

  searchInput.addEventListener('input', () => {
    selectedTargetId = null; // Clear selection when user types
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const query = searchInput.value.trim();
      if (query.length < 2) {
        resultsContainer.innerHTML = '';
        return;
      }
      try {
        const res = await api(`/api/index/profiles/?q=${encodeURIComponent(query)}`);
        const profiles = await res.json();
        resultsContainer.innerHTML = profiles
          .filter(p => p.id != profileId) // Exclude self
          .map(p => `<button class="induct-result-item" data-id="${p.id}">${escapeHtml(p.full_name)}</button>`)
          .join('');
      } catch (e) {
        resultsContainer.innerHTML = '<div class="text-red-500 p-2">Search failed</div>';
      }
    }, 300);
  });

  resultsContainer.addEventListener('click', (e) => {
    const target = e.target.closest('button');
    if (!target) return;
    selectedTargetId = target.dataset.id;
    searchInput.value = target.textContent;
    resultsContainer.innerHTML = ''; // Clear results after selection
  });

  saveBtn.addEventListener('click', async () => {
    const relationship = relationshipInput.value.trim();
    if (!selectedTargetId) {
      errorContainer.textContent = '// Please select a target profile from the search results.';
      show(errorContainer);
      return;
    }
    if (!relationship) {
      errorContainer.textContent = '// Please define the relationship.';
      show(errorContainer);
      return;
    }

    const payload = {
      to_profile: selectedTargetId,
      relationship: relationship,
    };

    const res = await api(`/api/index/profiles/${profileId}/connections/`, { method: 'POST', body: JSON.stringify(payload) });
    if (!res.ok) {
      showMessage('Failed to create connection.', 'error');
      return;
    }
    closeModal();
    openIndexDetail(profileId); // Reload the detail view to show the new connection
  });
}

let idxSearchTimer = null;
async function debounceIndexSearch() {
  clearTimeout(idxSearchTimer);
  idxSearchTimer = setTimeout(async () => {
    indexFilters = {
      q: (qs('#idx-q')?.value || '').trim(),
      classification: qs('#idx-class')?.value || '',
      status: qs('#idx-status')?.value || '',
      threat_level: qs('#idx-threat')?.value || '',
    };
    stateStore.set('abx_index_filters', indexFilters);
    const data = await loadIndexList(indexFilters);
    renderIndexList(data);
  }, 250);
}

function openIndexForm(existing = null) {
  const isEdit = !!existing;
  const title = isEdit ? 'Edit Profile' : 'New Profile';
  let vals = Object.assign({
    full_name: '', aliases: [], classification: '', status: 'Active', threat_level: 'None',
    biography: '', strengths: '', weaknesses: '', known_locations: [], known_vehicles: [], surveillance_files: [], affiliation_id: ''
  }, existing || {});
  const field = (title, input) => `<div><h3 class="panel-title text-sm">${title}</h3><hr class="panel-divider my-2">${input}</div>`;
  const toCSV = (arr) => (arr||[]).join(', ');
  const html = `
    <div class="cy-panel rounded-lg overflow-hidden" style="min-width: 720px;">
      <div class="modal-title py-3 border-b border-gray-800 bg-gray-950/70">
        <div class="text-lg font-semibold text-gray-100 tracking-wide mono px-4">» ${escapeHtml(title)}</div>
      </div>
      <div class="modal-body p-4 bg-gray-950/40 space-y-4 cy-scroll-slab" style="max-height: 70vh;">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          ${field('» Full Name', `<input id="f_full_name" class="terminal-input w-full" value="${vals.full_name || ''}">`)}
          ${field('» Aliases', `<input id="f_aliases" class="terminal-input w-full" value="${toCSV(vals.aliases)}">`)}
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          ${field('» Classification', `<select id="f_classification" class="terminal-input w-full">${Object.entries(ENUMS.classification).map(([k,v])=>`<option value="${k}" ${k===vals.classification?'selected':''}>${v}</option>`).join('')}</select>`)}
          ${field('» Status', `<select id="f_status" class="terminal-input w-full">${Object.entries(STATUS_LABELS).map(([key, label]) => `<option value="${key}" ${key === vals.status ? 'selected' : ''}>${label}</option>`).join('')}</select>`)}
          ${field('» Threat Level', `<select id="f_threat" class="terminal-input w-full">${Object.entries(THREAT_LABELS).map(([key, label]) => `<option value="${key}" ${key === vals.threat_level ? 'selected' : ''}>${label}</option>`).join('')}</select>`)}
        </div>
        ${field('» Biography', `<textarea id="f_bio" rows="4" class="terminal-input w-full font-serif">${vals.biography || ''}</textarea>`)}
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          ${field('» Strengths', `<textarea id="f_str" rows="2" class="terminal-input w-full mono">${vals.strengths||''}</textarea>`)}
          ${field('» Weaknesses', `<textarea id="f_weak" rows="2" class="terminal-input w-full mono">${vals.weaknesses||''}</textarea>`)}
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          ${field('» Known Locations', `<input id="f_locs" class="terminal-input w-full mono" value="${toCSV(vals.known_locations)}">`)}
          ${field('» Known Vehicles', `<input id="f_veh" class="terminal-input w-full mono" value="${toCSV(vals.known_vehicles)}">`)}
          ${field('» Surveillance URLs', `<input id="f_files" class="terminal-input w-full mono" value="${toCSV(vals.surveillance_urls)}">`)}
        </div>
      </div>
      <footer class="py-3 border-t border-gray-800 bg-gray-950/70 flex justify-end gap-3 px-4">
        <button data-action="close-modal" class="terminal-btn abort">// CANCEL</button>
        <button id="idx-save" class="terminal-btn commit">// SAVE</button>
      </footer>
    </div>
  `;
  openModal(html);
  qs('#idx-save').addEventListener('click', async () => {
    const payload = {
      full_name: qs('#f_full_name').value.trim(),
    };
    payload.aliases = parseDelimitedList(qs('#f_aliases')?.value).join(', ');
    const cls = qs('#f_classification').value;
    if (cls) payload.classification = cls;
    const st = qs('#f_status').value;
    if (st) payload.status = st;
    const th = qs('#f_threat').value;
    if (th) payload.threat_level = th;
    payload.biography = qs('#f_bio').value.trim();
    payload.strengths = qs('#f_str').value.trim();
    payload.weaknesses = qs('#f_weak').value.trim();
    payload.known_locations = parseDelimitedList(qs('#f_locs')?.value).join(', ');
    payload.known_vehicles = parseDelimitedList(qs('#f_veh')?.value).join(', ');
    payload.surveillance_urls = parseDelimitedList(qs('#f_files')?.value).join(', ');
    const url = '/api/index/profiles/' + (isEdit ? `${vals.id}/` : '');
    const method = isEdit ? 'PATCH' : 'POST';
    const res = await api(url, { method, body: JSON.stringify(payload) });
    if (!res.ok) { showMessage(`Save failed (${res.status})`, 'error'); return; }
    closeModal();
    if (isEdit) {
      openIndexDetail(existing.id);
    } else {
      const data = await loadIndexList({});
      renderIndexList(data);
    }
  });
}

// Hook delete/edit actions via global delegation
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action="idx-del"], [data-action="idx-edit"]');
  if (!btn) return;
  if (btn.getAttribute('data-action') === 'idx-del') {
    const profileName = btn.closest('.index-profile-view')?.querySelector('.cy-glitch')?.textContent || 
                        btn.closest('tr')?.querySelector('[data-action="idx-view"]')?.textContent || 
                        'this profile';
    openConfirmModal('Confirm Deletion', `Are you sure you want to delete ${profileName}? This action cannot be undone.`, async () => {
      const res = await api(`/api/index/profiles/${id}/`, { method: 'DELETE' });
      if (res.status === 204 || res.ok) {
        showMessage('Profile deleted.', 'info');
        const data = await loadIndexList(indexFilters);
        renderIndexList(data);
      } else {
        showMessage(`Delete failed (${res.status})`, 'error');
      }
    }, 'Delete', 'red');
  } else {
    // fetch item and open form
    const res = await api(`/api/index/profiles/${id}/`);
    if (!res.ok) { showMessage(`Load failed (${res.status})`, 'error'); return; }
    const item = await res.json();
    openIndexForm(item);
  }
});

const originalHandleNavigation = handleNavigation;
handleNavigation = async (page) => {
  if (page === 'index') {
    try {
      const data = await loadIndexList(indexFilters);
      renderIndexList(data);
    } catch (e) {
      showMessage(e.message || 'Failed to load Index', 'error');
    }
  } else if (page === 'lineage') {
    try {
      const data = await loadLineageAgents();
      renderLineageList(data);
    } catch (e) {
      showMessage(e.message || 'Failed to load Lineage', 'error');
    }
  } else if (page === 'scales') {
    try {
        const data = await loadFactions();
        renderFactionsList(data);
    } catch (e) {
        showMessage(e.message || 'Failed to load Scales', 'error');
    }
  } else if (page === 'silo') {
    const isLeadership = ['HQ', 'PROTECTOR', 'HEIR'].includes(currentUser.role);
    if (isLeadership) {
        try {
            await loadAndRenderSiloLeadershipDashboard();
        } catch (e) {
            showMessage(e.message || 'Failed to load Silo dashboard', 'error');
        }
        return;
    }
    try {
      // Default to the user's report list
      const reports = await loadMySiloReports();
      renderSiloList(reports);
    } catch (e) {
      showMessage(e.message || 'Failed to load Silo reports', 'error');
    }
  } else if (page === 'loom') {
    try {
      await loadAndRenderLoomDashboard();
    } catch (e) {
      showMessage(e.message || 'Failed to load The Loom', 'error');
    }
  } else {
    originalHandleNavigation(page);
  }
}

let currentLineageAgent = null;

function openInductAgentModal() {
  const html = `
    <div class="cy-panel rounded-lg overflow-hidden" style="min-width: 640px;">
      <div class="modal-title py-3 border-b border-gray-800 bg-gray-950/70">
        <div class="text-lg font-semibold text-gray-100 tracking-wide mono px-4">» INDUCT ASSET: LINK TO INDEX</div>
      </div>
      <div class="modal-body p-4 bg-gray-950/40 space-y-3">
        <input id="induct-search" class="terminal-input w-full" placeholder="Search The Index for candidate..." autocomplete="off">
        <div id="induct-error" class="text-red-400 mono text-sm hidden"></div>
        <div id="induct-results" class="cy-scroll-slab h-64 overflow-y-auto border border-gray-800 rounded bg-gray-900/50">
          <div class="text-center text-gray-500 mono text-xs py-8">// Awaiting search query...</div>
        </div>
      </div>
      <footer class="py-3 border-t border-gray-800 bg-gray-950/70 flex justify-end gap-3 px-4">
        <button data-action="close-modal" class="terminal-btn abort">// CANCEL</button>
      </footer>
    </div>
  `;
  openModal(html);

  const searchInput = qs('#induct-search');
  const resultsContainer = qs('#induct-results');
  const errorContainer = qs('#induct-error');
  let searchTimer = null;

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const query = searchInput.value.trim();
      if (query.length < 2) {
        resultsContainer.innerHTML = `<div class="text-center text-gray-500 mono text-xs py-8">// Awaiting search query...</div>`;
        return;
      }

      resultsContainer.innerHTML = `<div class="cy-spinner"></div>`;
      try {
        const res = await api(`/api/index/profiles/?q=${encodeURIComponent(query)}`);
        if (!res.ok) throw new Error('Search failed');
        const profiles = await res.json();

        if (!profiles.length) {
          resultsContainer.innerHTML = `<div class="text-center text-gray-500 mono text-xs py-8">// NO MATCHING PROFILES FOUND</div>`;
          return;
        }

        resultsContainer.innerHTML = profiles.map(p => `
          <button class="induct-result-item" data-action="induct-select" data-id="${p.id}" data-name="${escapeHtml(p.full_name)}">
            <span class="font-semibold text-emerald-400">${escapeHtml(p.full_name)}</span>
            <span class="text-gray-400 text-xs">(${escapeHtml(p.classification || 'Unclassified')})</span>
          </button>
        `).join('');
      } catch (e) {
        resultsContainer.innerHTML = `<div class="text-center text-red-500 mono text-xs py-8">// SEARCH FAILED</div>`;
      }
    }, 300);
  });

  resultsContainer.addEventListener('click', async (e) => {
    const target = e.target.closest('[data-action="induct-select"]');
    if (!target) return;

    const profileId = target.getAttribute('data-id');
    const profileName = target.getAttribute('data-name');
    hide(errorContainer);

    try {
      // This endpoint doesn't exist yet, so we simulate.
      // In a real scenario, this would be a single API call.
      // const checkRes = await api(`/api/lineage/check-inductee/?index_profile_id=${profileId}`);
      // if (!checkRes.ok) throw new Error('Validation failed');
      // const { available } = await checkRes.json();
      // if (!available) { ... }

      // --- SIMULATION ---
      const allAgentsRes = await api('/api/lineage/agents/');
      if (!allAgentsRes.ok) throw new Error('Validation failed');
      const allAgents = await allAgentsRes.json();
      const isInducted = allAgents.some(agent => String(agent.index_profile_id) === String(profileId));
      // --- END SIMULATION ---

      if (isInducted) {
        errorContainer.textContent = '// ERROR: ASSET ALREADY INDUCTED.';
        show(errorContainer);
        return;
      }

      // If available, proceed to creation form
      closeModal();
      const blankAgent = {
        alias: profileName,
        real_name: '',
        status: 'Active',
        loyalty_type: 'Unknown',
        key_skill: '',
        personality: '',
        index_profile_id: profileId,
        isNew: true // Flag for the renderer
      };
      renderLineageDossier(blankAgent);
    } catch (err) {
      errorContainer.textContent = `// ERROR: ${err.message}`;
      show(errorContainer);
    }
  });
}

async function openLineageDossier(id) {
  if (!id) return;
  try {
    const res = await api(`/api/lineage/agents/${id}/`);
    if (!res.ok) {
      showMessage(`Failed to load dossier (${res.status})`, 'error');
      return;
    }
    const agent = await res.json();
    currentLineageAgent = agent;
    renderLineageDossier(agent);
  } catch (err) {
    showMessage(err.message || 'Failed to load dossier.', 'error');
  }
}

const renderCustomSelect = (id, options, selectedValue, placeholder = 'Select...') => {
  const selectedLabel = options[selectedValue] || placeholder;
  const optionsHtml = Object.entries(options).map(([key, label]) => 
      `<div class="custom-select-option" data-value="${key}">${escapeHtml(label)}</div>`
  ).join('');

  return `
      <div class="custom-select-wrapper" data-select-id="${id}">
          <input type="hidden" id="${id}" value="${selectedValue || ''}">
          <button type="button" class="custom-select-display terminal-input w-full">
              <span class="selected-value-text">${escapeHtml(selectedLabel)}</span>
          </button>
          <div class="custom-select-options hidden">${optionsHtml}</div>
      </div>
  `;
};
function renderLineageDossier(agent, mode = 'view', newlySelectedProfile = null) {
  const area = qs('#abacus-content-area');
  if (!area) return;
  const isNew = agent.isNew || false;
  const isEdit = isNew || mode === 'edit';

  const secureCommsField = (label, content) => `
    <div class="comms-field">
        <span class="text-gray-400 mono uppercase text-xs tracking-wider">${label}</span>
        <div class="mono text-gray-100">${content}</div>
    </div>
  `;

  const isLeadership = ['HQ', 'PROTECTOR', 'HEIR'].includes(currentUser.role);

  const devPlanContent = isEdit
    ? `
        <div class="space-y-3 p-1">
            ${secureCommsField('Current Focus', `<input id="ld_dev_focus" class="terminal-input w-full" value="${escapeHtml(agent.dev_plan_focus || '')}" placeholder="e.g., Improve social engineering">`)}
            ${secureCommsField('Next Module', `<input id="ld_dev_training" class="terminal-input w-full" value="${escapeHtml(agent.dev_plan_next || '')}" placeholder="e.g., Advanced demolitions w/ Yeager">`)}
            <textarea id="ld_dev_notes" class="terminal-input w-full mt-2" rows="3" placeholder="// Leadership notes on development...">${escapeHtml(agent.dev_plan_notes || '')}</textarea>
        </div>
      `
    : `
        <div class="space-y-3 p-1">${[
          secureCommsField('Current Focus', escapeHtml(agent.dev_plan_focus || '// N/A')),
          secureCommsField('Next Module', escapeHtml(agent.dev_plan_next || '// N/A')),
          `<div class="terminal-value p-1 mt-2">${multilineContent(agent.dev_plan_notes, '// NO DEVELOPMENT NOTES')}</div>`,
        ].join('')}</div>
      `;

  const secureCommsContent = isEdit
    ? `
        <div class="space-y-3 p-1">
            ${secureCommsField('Primary Channel', `<input id="ld_sc_channel" class="terminal-input w-full" value="${escapeHtml(agent.secure_comms_channel || '')}" placeholder="e.g., Encrypted Text">`)}
            ${secureCommsField('Contact ID', `<input id="ld_sc_contact" class="terminal-input w-full" value="${escapeHtml(agent.secure_comms_contact_id || '')}" placeholder="e.g., 867-5309 (Burner)">`)}
            ${secureCommsField('Duress Code', `<input id="ld_sc_duress" class="terminal-input w-full" value="${escapeHtml(agent.duress_code || '')}" placeholder="e.g., The weather is bad...">`)}
        </div>
      `
    : `
        <div class="space-y-3 p-1">${[
          secureCommsField('Primary Channel', escapeHtml(agent.secure_comms_channel || '// N/A')),
          secureCommsField('Contact ID', escapeHtml(agent.secure_comms_contact_id || '// N/A')),
          secureCommsField('Duress Code', `"${escapeHtml(agent.duress_code || '// N/A')}"`),
          secureCommsField('Last Contacted', formatTimestamp(agent.last_contacted_at) || '// N/A'),
        ].join('')}</div>
      `;

  // Clear any other BG classes
  area.className = 'flex-1 p-4 md:p-6 overflow-y-auto transition-colors duration-500';
  area.classList.add('lineage-bg');

  const statusOptions = {
    'ACTIVE': 'Active',
    'IN_DEEP_COVER': 'In-Deep-Cover',
    'COMPROMISED': 'Compromised',
    'INACTIVE': 'Inactive',
    'MIA': 'Missing in Action',
    'RETIRED': 'Retired',
  };
  const loyaltyOptions = {
    'IDEOLOGICAL': 'Ideological',
    'TRANSACTIONAL': 'Transactional',
    'PERSONAL': 'Personal',
    'COERCED': 'Coerced',
    'UNKNOWN': 'Unknown',
  };

  const renderOptions = (opts, current) => Object.entries(opts).map(([key, label]) => `<option value="${key}" ${key === current ? 'selected' : ''}>${label}</option>`).join('');

  const skills = parseDelimitedList(agent.key_skill);

  const headerButtons = isEdit
    ? `
        <button class="terminal-btn commit" data-action="${isNew ? 'lineage-create' : 'lineage-save'}" data-id="${agent.id || ''}">// COMMIT</button>
        <button class="terminal-btn abort" data-action="${isNew ? 'lineage-back' : 'lineage-abort-edit'}">// ABORT</button>
      `
    : `
        ${agent.index_profile_id ? `<button class="terminal-btn-outline" data-action="idx-view" data-id="${agent.index_profile_id}">» View Public Profile</button>` : ''}
        <button class="terminal-btn-outline" data-action="lineage-edit" data-id="${agent.id}">EDIT</button>
        <button class="terminal-btn-outline" data-action="lineage-back">BACK</button> 
      `;
 
  const realNameContent = isEdit
    ? `<input id="ld_real_name" class="terminal-input w-full" value="${escapeHtml(agent.real_name || '')}" placeholder="// REDACTED">`
    : `<div class="terminal-value p-2">${escapeHtml(agent.real_name || '// REDACTED')}</div>`;

  const statusContent = isEdit
    ? renderCustomSelect('ld_status', statusOptions, agent.status)
    : `<div class="terminal-value p-2">${escapeHtml(statusOptions[agent.status] || agent.status || 'Unknown')}</div>`;

  const loyaltyContent = isEdit
    ? renderCustomSelect('ld_loyalty', loyaltyOptions, agent.loyalty_type)
    : `<div class="terminal-value p-2">${escapeHtml(loyaltyOptions[agent.loyalty_type] || agent.loyalty_type || 'Unknown')}</div>`;

  const skillsContent = `
    <div class="tag-editor" data-kind="skills">
      <div id="ld_skills_tags" class="diplomacy-tag-wrap"></div>
      ${isEdit ? '<input id="ld_skills_input" class="tag-editor-input mono" placeholder="Type to add skill...">' : ''}
    </div>
  `;

  const personalityContent = isEdit
    ? `<textarea id="ld_personality" class="terminal-input w-full h-full cy-scroll-slab font-serif" rows="12" placeholder="// Enter assessment notes...">${escapeHtml(agent.personality || '')}</textarea>`
    : `<div class="terminal-value p-2 cy-scroll-slab font-serif h-full">${multilineContent(agent.personality, '// NO ASSESSMENT NOTES...')}</div>`;

  area.innerHTML = `
    <div class="lineage-dossier ${isEdit ? 'edit-mode' : ''}" data-agent-id="${agent.id}">
      <div class="flex flex-wrap items-center justify-between gap-3 cypher-header pb-4">
        <div class="flex flex-wrap items-center gap-4 min-w-0">
          <h2 class="text-xl font-bold lineage-title tracking-widest truncate">
            <button data-action="lineage-back" class="breadcrumb-link">LINEAGE ROSTER</button>
            <span class="breadcrumb-sep">/</span>
            <span class="text-white">${isNew ? 'INDUCTING' : 'DOSSIER'}: ${escapeHtml(agent.alias)}</span>
          </h2>
        </div>
        <div class="flex items-center gap-2">
          ${headerButtons}
        </div>
      </div>
      <hr class="page-divider mb-6">

      ${isEdit && !isNew ? `
        <div class="mb-6">
            <h3 class="panel-title">» Linked Public Profile</h3>
            <hr class="panel-divider my-2">
            <div class="flex items-center gap-4 p-2 bg-gray-950/30 border border-gray-800 rounded">
                <span id="linked-profile-name" class="flex-1 text-gray-100 mono">${escapeHtml(newlySelectedProfile?.name || agent.index_profile?.full_name || 'None')}</span>
                <button class="terminal-btn-outline text-xs" data-action="lineage-change-link" data-id="${agent.id}">» Change Link</button>
            </div>
        </div>
      ` : ''}

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="space-y-6">
          <div>
            <h3 class="panel-title">» Real Name</h3>
            <hr class="panel-divider my-2">
            <div>${realNameContent}</div>
          </div>

          <div class="grid grid-cols-2 gap-6">
            <div>
              <h3 class="panel-title">» Internal Status</h3>
              <hr class="panel-divider my-2">
              <div>${statusContent}</div>
            </div>
            <div>
              <h3 class="panel-title">» Loyalty</h3>
              <hr class="panel-divider my-2">
              <div>${loyaltyContent}</div>
            </div>
          </div>

          <div>
            <h3 class="panel-title">» Skill Set</h3>
            <hr class="panel-divider my-2">
            <div>${skillsContent}</div>
          </div>

          ${isLeadership ? `
            <div>
              <h3 class="panel-title">» Development Plan (Strategic)</h3>
              <hr class="panel-divider my-2">
              <div>${devPlanContent}</div>
            </div>` : ''}

          <div>
            <h3 class="panel-title">» Secure Comms Protocol</h3>
            <hr class="panel-divider my-2">
            <div>${secureCommsContent}</div>
          </div>

          <div>
            <h3 class="panel-title">» Assigned Assets</h3>
            <hr class="panel-divider my-2">
            <div id="ld_assets" class="text-sm text-gray-300 mono cy-scroll-slab h-48 history-feed">
              <div class="cy-spinner"></div>
            </div>
          </div>
        </div>

        <div class="space-y-6">
          <div>
            <h3 class="panel-title">» Psychological Evaluation</h3>
            <hr class="panel-divider my-2">
            <div class="text-box-wrapper">${personalityContent}</div>
          </div>
          <div>
            <h3 class="panel-title">» Operational History</h3>
            <hr class="panel-divider my-2">
            <div id="ld_ops_history" class="text-sm text-gray-300 mono cy-scroll-slab h-48 history-feed">
              <div class="cy-spinner"></div>
            </div>
          </div>
          <div>
            <h3 class="panel-title">» Known Connections</h3>
            <hr class="panel-divider my-2">
            <div id="ld_connections" class="text-sm text-gray-300 mono cy-scroll-slab h-48 history-feed">
              <div class="cy-spinner"></div>
            </div>
          </div>
          <div>
            <h3 class="panel-title">» Dossier History</h3>
            <hr class="panel-divider my-2">
            <div>
              <div id="ld_history" class="text-sm text-gray-300 mono cy-scroll-slab h-48 history-feed">
                <div class="text-gray-500 text-xs mono text-center py-6">// Dossier history log coming soon.</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  loadAndRenderSubPanels(agent);

  const skillsEditor = {
    list: skills,
    container: qs('#ld_skills_tags'),
    input: qs('#ld_skills_input'),
  };

  const renderSkills = () => {
    if (!skillsEditor.container) return;
    skillsEditor.container.innerHTML = skillsEditor.list.map((skill, idx) => `
      <span class="diplo-tag skill" data-role="tag" data-index="${idx}">
        ${escapeHtml(skill)}
        <button type="button" class="tag-remove" data-role="tag-remove" data-index="${idx}" aria-label="Remove ${escapeHtml(skill)}">×</button>
      </span>`).join('');
  };

  renderSkills(); // Always render the tags for view mode

  // --- Edit Mode Logic ---
  if (isEdit) {
    skillsEditor.input.addEventListener('keydown', (e) => {
      if (['Enter', 'Tab', ','].includes(e.key)) {
        e.preventDefault();
        const value = skillsEditor.input.value.trim();
        if (value && !skillsEditor.list.includes(value)) {
          skillsEditor.list.push(value);
          renderSkills();
        }
        skillsEditor.input.value = '';
      }
    });

    skillsEditor.container.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-role="tag-remove"]');
      if (!btn) return;
      const idx = Number(btn.getAttribute('data-index'));
      if (!Number.isNaN(idx) && idx >= 0 && idx < skillsEditor.list.length) {
        skillsEditor.list.splice(idx, 1);
        renderSkills();
      }
    });

    // --- Save Logic ---
    const saveBtn = qs('[data-action="lineage-save"], [data-action="lineage-create"]');
    saveBtn.addEventListener('click', async () => {
      const id = saveBtn.getAttribute('data-id');
      const isCreating = saveBtn.getAttribute('data-action') === 'lineage-create';

      const payload = {
        alias: agent.alias, // Pre-filled from Index profile
        real_name: qs('#ld_real_name').value.trim(),
        status: qs('#ld_status').value,
        loyalty_type: qs('#ld_loyalty').value,
        personality: qs('#ld_personality').value.trim(),
        key_skill: skillsEditor.list.join(', '),
        secure_comms_channel: qs('#ld_sc_channel')?.value?.trim() || '',
        secure_comms_contact_id: qs('#ld_sc_contact')?.value?.trim() || '',
        duress_code: qs('#ld_sc_duress')?.value?.trim() || '',
        dev_plan_focus: qs('#ld_dev_focus')?.value?.trim() || '',
        dev_plan_next: qs('#ld_dev_training')?.value?.trim() || '',
        dev_plan_notes: qs('#ld_dev_notes')?.value?.trim() || '',
        // If a new profile was selected during this edit session, use its ID.
        // Otherwise, the backend will not update the field.
        index_profile_id: newlySelectedProfile ? newlySelectedProfile.id : undefined,
      };
      if (isCreating && agent.index_profile_id) {
        payload.index_profile_id = agent.index_profile_id;
      }

      const url = isCreating ? '/api/lineage/agents/' : `/api/lineage/agents/${id}/`;
      const method = isCreating ? 'POST' : 'PATCH';

      const res = await api(url, { method, body: JSON.stringify(payload) });

      // If index_profile_id was sent as undefined, remove it so it doesn't cause issues
      if (payload.index_profile_id === undefined) {
        delete payload.index_profile_id;
      }

      if (!res.ok) {
        let errorMsg = `Save failed (${res.status})`;
        try {
          const errData = await res.json();
          // Show specific backend error if available (e.g., "alias already exists")
          errorMsg = Object.values(errData).flat().join(' ') || errorMsg;
        } catch {}
        showMessage(errorMsg, 'error');
        return;
      }
      showMessage(isCreating ? 'Agent inducted.' : 'Dossier updated.', 'info');
      if (isCreating) {
        handleNavigation('lineage'); // Go back to the main roster after creating
      } else {
        openLineageDossier(id); // Reload the current dossier after editing
      }
    });
  }
}

async function loadAndRenderSubPanels(agent) {
  // This function will orchestrate loading data for the new panels.
  // For now, it uses mock data.

  // --- Operational History ---
  const opsContainer = qs('#ld_ops_history');
  if (opsContainer) {
    // Mock API call: await api(`/api/loom/operations/?personnel_id=${agent.id}`);
    const mockOps = [
      { codename: 'Operation: Midas Touch', role: 'Infiltration Specialist', status: 'Concluded - Success' },
      { codename: 'Operation: Nightfall', role: 'Surveillance', status: 'Active' },
    ];
    setTimeout(() => {
      if (!mockOps.length) {
        opsContainer.innerHTML = `<div class="text-gray-500 text-xs mono text-center py-6">// NO OPERATIONAL HISTORY</div>`;
        return;
      }
      opsContainer.innerHTML = mockOps.map(op => `
        <div class="history-item">
          <div class="font-semibold text-gray-100">${escapeHtml(op.codename)}</div>
          <div class="text-xs text-gray-400">ROLE: ${escapeHtml(op.role)} | STATUS: ${escapeHtml(op.status)}</div>
        </div>
      `).join('');
    }, 800);
  }

  // --- Known Connections ---
  const connContainer = qs('#ld_connections');
  if (connContainer) {
    // Correctly reference the nested profile ID
    const profileId = agent.index_profile?.id;
    if (!profileId) {
      connContainer.innerHTML = `<div class="text-gray-500 text-xs mono text-center py-6">// AGENT NOT LINKED TO INDEX</div>`;
    } else {
      try {
        // This endpoint needs to be created and registered in your urls.py
        const res = await api(`/api/index/profiles/${profileId}/connections/`);
        if (!res.ok) throw new Error('Failed to load connections');
        const connections = await res.json();

        if (!connections.length) {
          connContainer.innerHTML = `<div class="text-gray-500 text-xs mono text-center py-6">// NO KNOWN CONNECTIONS</div>`;
        } else {
          connContainer.innerHTML = connections.map(c => {
            const isFrom = c.from_profile == profileId;
            // If the connection is *from* our agent, the other party is 'to_profile'.
            // If the connection is *to* our agent, the other party is 'from_profile'.
            const otherProfile = isFrom ? c.to_profile_details : c.from_profile_details;
            
            return `
              <div class="history-item">
                <div class="font-semibold text-gray-100">${escapeHtml(otherProfile.full_name)}</div>
                <div class="text-xs text-gray-400">RELATIONSHIP: ${escapeHtml(c.relationship)}</div>
              </div>
            `;
          }).join('');
        }
      } catch (e) {
        connContainer.innerHTML = `<div class="text-gray-500 text-xs mono text-center py-6">// FAILED TO LOAD CONNECTIONS</div>`;
      }
    }
  }

  // --- Assigned Assets ---
  const assetsContainer = qs('#ld_assets');
  if (assetsContainer) {
    // Mock API call: await api(`/api/vault/assets/?assigned_agent_id=${agent.id}`);
    const mockAssets = [
      { type: 'Vehicle', name: 'Blacked-out Granger', details: 'Plate: 88Talon1' },
      { type: 'Safehouse', name: '123 Eclipse Blvd, Apt 4B', details: '' },
      { type: 'Funds', name: '$25,000 Operational Cash', details: '' },
    ];
    setTimeout(() => {
      if (!mockAssets.length) {
        assetsContainer.innerHTML = `<div class="text-gray-500 text-xs mono text-center py-6">// NO ASSETS ASSIGNED</div>`;
        return;
      }
      assetsContainer.innerHTML = mockAssets.map(a => `
        <div class="history-item">
          <div class="font-semibold text-gray-100">${escapeHtml(a.name)}</div>
          ${a.details ? `<div class="text-xs text-gray-400">${escapeHtml(a.details)}</div>` : ''}
        </div>
      `).join('');
    }, 1500);
  }

  // Placeholder for Dossier History
  // This will be replaced with a real API call in a future step.
}

// ===== The Lineage UI =====
async function loadLineageAgents() {
  const res = await api('/api/lineage/agents/');
  if (!res.ok) throw new Error(`Failed to load agents (${res.status})`);
  return res.json();
}

function getStatusClass(status) {
  const s = (status || '').toLowerCase();
  // Handle new statuses from dossier form
  if (s.includes('deep-cover')) return 'status-deep-cover';
  if (s.includes('compromised')) return 'status-compromised';

  switch (s) {
    case 'active': return 'status-active';
    case 'in-deep-cover': return 'status-deep-cover';
    case 'compromised': return 'status-compromised';
    default: return 'status-unknown';
  }
}

function renderLineageList(agents) {
  const area = qs('#abacus-content-area');
  if (!area) return;
  // Clear any other BG classes
  area.className = 'flex-1 p-4 md:p-6 overflow-y-auto transition-colors duration-500';
  area.classList.add('lineage-bg'); // Add a distinct background for this section

  const isLeadership = ['HQ', 'PROTECTOR', 'HEIR'].includes(currentUser.role);

  const agentBars = agents.map(agent => {
    // Use the public name from the linked Index Profile as the primary display name.
    // Fall back to the agent's internal alias if not linked.
    const displayName = agent.index_profile?.full_name || agent.alias || 'Unknown Agent';
    const aliasCell = isLeadership
      ? `<button class="roster-bar-alias" data-action="lineage-view-dossier" data-id="${agent.id}">» ${escapeHtml(displayName)}</button>`
      : `<span class="roster-bar-alias-static">» ${escapeHtml(displayName)}</span>`;

    const publicFileLink = agent.index_profile?.id
      ? `<button class="roster-bar-public-link" data-action="idx-view" data-id="${agent.index_profile.id}" title="View Index Profile #${agent.index_profile.id}">[View Public File]</button>`
      : ``;

    const metaContent = isLeadership
      ? `
          <span class="roster-bar-meta">STATUS: <span class="font-semibold text-gray-100">[${escapeHtml(agent.status)}]</span></span>
          <span class="roster-bar-meta">LOYALTY: <span class="font-semibold text-gray-100">[${escapeHtml(agent.loyalty_type || 'Unknown')}]</span></span>
        `
      : `
          <span class="roster-bar-meta">STATUS: <span class="font-semibold text-gray-100">[${escapeHtml(agent.status)}]</span></span>
          <span class="roster-bar-meta">SKILLS: <span class="font-semibold text-gray-100">${(agent.skills || []).map(s => `[${escapeHtml(s)}]`).join(' ')}</span></span>
        `;

    return `
      <div class="roster-bar ${isLeadership ? 'clickable' : ''}" ${isLeadership ? `data-action="lineage-view-dossier" data-id="${agent.id}"` : ''}>
        ${aliasCell}
        <div class="roster-bar-meta-group">
          ${metaContent}
        </div>
        ${publicFileLink}
      </div>
    `;
  }).join('');

  area.innerHTML = `
    <div class="panel cypher-header p-4 relative">
      <div class="lineage-container">
        <div class="flex items-center justify-between mb-4">
          <h3 class="panel-title text-xl">» LINEAGE ROSTER</h3>
          ${isLeadership ? '<button class="terminal-btn commit" data-action="lineage-induct-agent">» Induct Agent</button>' : ''}
        </div>
        <div class="roster-list-wrapper mt-2 cy-scroll-slab space-y-2" style="max-height: 60vh;">
          ${agentBars || '<div class="text-center py-8 text-gray-500 mono">// NO AGENTS FOUND</div>'}
        </div>
      </div>
    </div>
  `;
}

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action^="lineage-"]');
  if (!target) return;
  const action = target.getAttribute('data-action');

  // Prevent the roster-bar's action from firing if a button inside it was clicked.
  if (action === 'lineage-view-dossier' && e.target.closest('button') !== target) {
    return;
  }

  const id = target.getAttribute('data-id');

  if (action === 'lineage-view-dossier') {
    openLineageDossier(id);
  } else if (action === 'lineage-induct-agent') {
    openInductAgentModal();
  } else if (action === 'lineage-edit') {
    if (currentLineageAgent) renderLineageDossier(currentLineageAgent, 'edit');
  } else if (action === 'lineage-abort-edit') {
    if (currentLineageAgent) renderLineageDossier(currentLineageAgent, 'view');
  } else if (action === 'lineage-back') {
    handleNavigation('lineage');
  } else if (action === 'lineage-change-link') {
    const agentId = target.closest('.lineage-dossier')?.getAttribute('data-agent-id');
    openChangeLinkModal(agentId);
  }
});

document.addEventListener('click', (e) => {
  // Close any open custom selects if clicking outside
  if (!e.target.closest('.custom-select-wrapper')) {
    qsa('.custom-select-options').forEach(el => el.classList.add('hidden'));
  }

  const displayBtn = e.target.closest('.custom-select-display');
  if (displayBtn) {
    const wrapper = displayBtn.closest('.custom-select-wrapper');
    const optionsList = wrapper.querySelector('.custom-select-options');
    optionsList.classList.toggle('hidden');
    return;
  }

  const option = e.target.closest('.custom-select-option');
  if (option) {
    const wrapper = option.closest('.custom-select-wrapper');
    const hiddenInput = wrapper.querySelector('input[type="hidden"]');
    const displaySpan = wrapper.querySelector('.selected-value-text');
    
    hiddenInput.value = option.dataset.value;
    displaySpan.textContent = option.textContent;
    option.parentElement.classList.add('hidden');
  }
});

function openChangeLinkModal(agentId) {
  if (!agentId) return;

  const html = `
    <div class="cy-panel rounded-lg overflow-hidden" style="min-width: 640px;">
      <div class="modal-title py-3 border-b border-gray-800 bg-gray-950/70">
        <div class="text-lg font-semibold text-gray-100 tracking-wide mono px-4">» CHANGE LINKED PUBLIC PROFILE</div>
      </div>
      <div class="modal-body p-4 bg-gray-950/40 space-y-3">
        <input id="change-link-search" class="terminal-input w-full" placeholder="Search The Index for new profile..." autocomplete="off">
        <div id="change-link-error" class="text-red-400 mono text-sm hidden"></div>
        <div id="change-link-results" class="cy-scroll-slab h-64 overflow-y-auto border border-gray-800 rounded bg-gray-900/50">
          <div class="text-center text-gray-500 mono text-xs py-8">// Awaiting search query...</div>
        </div>
      </div>
      <footer class="py-3 border-t border-gray-800 bg-gray-950/70 flex justify-end gap-3 px-4">
        <button data-action="close-modal" class="terminal-btn abort">// CANCEL</button>
      </footer>
    </div>
  `;
  openModal(html);

  const searchInput = qs('#change-link-search');
  const resultsContainer = qs('#change-link-results');
  const errorContainer = qs('#change-link-error');
  let searchTimer = null;

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const query = searchInput.value.trim();
      if (query.length < 2) {
        resultsContainer.innerHTML = `<div class="text-center text-gray-500 mono text-xs py-8">// Awaiting search query...</div>`;
        return;
      }

      resultsContainer.innerHTML = `<div class="cy-spinner"></div>`;
      try {
        const res = await api(`/api/index/profiles/?q=${encodeURIComponent(query)}`);
        if (!res.ok) throw new Error('Search failed');
        const profiles = await res.json();

        if (!profiles.length) {
          resultsContainer.innerHTML = `<div class="text-center text-gray-500 mono text-xs py-8">// NO MATCHING PROFILES FOUND</div>`;
          return;
        }

        resultsContainer.innerHTML = profiles.map(p => `
          <button class="induct-result-item" data-action="change-link-select" data-id="${p.id}" data-name="${escapeHtml(p.full_name)}">
            <span class="font-semibold text-emerald-400">${escapeHtml(p.full_name)}</span>
            <span class="text-gray-400 text-xs">(${escapeHtml(p.classification || 'Unclassified')})</span>
          </button>
        `).join('');
      } catch (e) {
        resultsContainer.innerHTML = `<div class="text-center text-red-500 mono text-xs py-8">// SEARCH FAILED</div>`;
      }
    }, 300);
  });

  resultsContainer.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action="change-link-select"]');
    if (!target) return;

    const profileId = target.getAttribute('data-id');
    const profileName = target.getAttribute('data-name');
    
    // Re-render the dossier in edit mode with the newly selected profile info
    renderLineageDossier(currentLineageAgent, 'edit', { id: profileId, name: profileName });
    closeModal();
  });
}

// ===== The Scales UI =====
async function loadFactions() {
  const res = await api('/api/scales/factions/');
  if (!res.ok) throw new Error(`Failed to load factions (${res.status})`);
  return res.json();
}

function threatTierBadge(tier) {
  const map = {
    'DORMANT': 'bg-gray-800 text-gray-300 border-gray-700',
    'NOMINAL': 'bg-green-900/50 text-green-300 border-green-700',
    'ELEVATED': 'bg-yellow-900/50 text-yellow-300 border-yellow-700',
    'SEVERE': 'bg-orange-900/50 text-orange-300 border-orange-700',
    'CRITICAL': 'bg-red-900/50 text-red-300 border-red-700',
  };
  return map[tier] || map.DORMANT;
}

function threatDotClass(tier) {
  const map = {
    'DORMANT': 'bg-gray-500',
    'NOMINAL': 'bg-green-500',
    'ELEVATED': 'bg-yellow-500',
    'SEVERE': 'bg-orange-500',
    'CRITICAL': 'bg-red-500',
  };
  return map[tier] || map.DORMANT;
}

// Simple decrypt flicker animation for redacted text
function animateDecrypt(el, finalText) {
  if (!el) return;
  const glyphs = '█▓▒░#@$%&*ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const len = (finalText || '').length;
  let step = 0;
  const max = 14;
  const timer = setInterval(() => {
    step++;
    let s = '';
    for (let i = 0; i < len; i++) {
      const reveal = Math.random() < (step / max);
      s += reveal ? finalText[i] : glyphs[Math.floor(Math.random() * glyphs.length)];
    }
    el.textContent = s;
    if (step >= max) {
      clearInterval(timer);
      el.textContent = finalText;
      el.classList.remove('redacted');
      el.classList.add('decrypted');
    }
  }, 40);
}

function animateMetricValue(sel, val) {
  const el = typeof sel === 'string' ? qs(sel) : sel;
  if (!el) return;
  el.textContent = String(val);
  el.classList.remove('metric-tick');
  // Force reflow to restart animation
  void el.offsetWidth;
  el.classList.add('metric-tick');
}

function renderFactionsList(items) {
  const area = qs('#abacus-content-area');
  if (!area) return;
  area.classList.add('lineage-bg');
  const canEdit = ['HQ','PROTECTOR','HEIR'].includes(currentUser.role);
  area.innerHTML = `
    <div class="mb-4 flex items-center justify-between">
      <h2 class="text-xl font-bold lineage-title tracking-widest">
        <button data-action="navigate" data-page="lineage" class="breadcrumb-link">LINEAGE ROSTER</button>
        <span class="breadcrumb-sep">/</span>
        <span class="text-white">THE SCALES</span>
      </h2>
      <div class="flex items-center gap-2">
        <input id="fa-search" class="terminal-input w-64" placeholder="Search factions…" autocomplete="off" autocapitalize="none" spellcheck="false">
        ${canEdit ? '<button id="faction-new" class="terminal-btn-outline text-sm">New Faction</button>' : ''}
      </div>
    </div>
    <div class="overflow-x-auto panel">
      <table class="min-w-full text-sm">
        <thead class="bg-gray-900 text-gray-400">
          <tr>
            <th class="px-3 py-2 text-left"><button data-action="fa-sort" data-key="name" class="hover:underline">Faction Name</button></th>
            <th class="px-3 py-2 text-left"><button data-action="fa-sort" data-key="threat_level" class="hover:underline">Threat Level</button></th>
            <th class="px-3 py-2 text-left"><button data-action="fa-sort" data-key="member_count" class="hover:underline">Members</button></th>
          </tr>
        </thead>
        <tbody id="fa-tbody" class="text-gray-200"></tbody>
      </table>
    </div>`;

  let currentRows = items.slice();
  let sortKey = 'name';
  let sortDir = 'asc';

  const tbody = qs('#fa-tbody');
  const renderRows = () => {
    const THREAT_ORDER = {
      'CRITICAL': 5,
      'SEVERE': 4,
      'ELEVATED': 3,
      'NOMINAL': 2,
      'DORMANT': 1,
    };
    const sorted = currentRows.sort((a,b)=>{
      let va = a[sortKey], vb = b[sortKey];
      if (sortKey === 'threat_level') {
        va = THREAT_ORDER[va] || 0;
        vb = THREAT_ORDER[vb] || 0;
        return sortDir === 'asc' ? va - vb : vb - va;
      } else if (sortKey === 'member_count') { 
        va = Number(va||0); vb = Number(vb||0); 
        return sortDir === 'asc' ? va - vb : vb - va;
      }
      return sortDir === 'asc' ? String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) : String(vb).localeCompare(String(va), undefined, { numeric: true, sensitivity: 'base' });
    });
    tbody.innerHTML = sorted.map(f => ` 
      <tr class="border-t border-gray-800 hover:bg-gray-900/50" data-id="${f.id}">
        <td class="px-3 py-2"><button class="hover:underline" data-action="scales-view" data-id="${f.id}">${f.name}</button></td>
        <td class="px-3 py-2"><span class="inline-block px-2 py-0.5 rounded border ${threatTierBadge(f.threat_level)}">${f.threat_level || 'Dormant'}</span></td>
        <td class="px-3 py-2">${f.member_count ?? 0}</td>
      </tr>`).join('');
  };
  renderRows();
  
  let faSearchTimer = null;
  qs('#fa-search').addEventListener('input', (e) => {
    const searchTerm = (e.target.value || '').trim();
    clearTimeout(faSearchTimer);
    faSearchTimer = setTimeout(async () => {
      const res = await api(`/api/scales/factions/?search=${encodeURIComponent(searchTerm)}`);
      if (!res.ok) { showMessage('Search failed', 'error'); return; }
      currentRows = await res.json();
      renderRows();
    }, 300);
  });

  document.addEventListener('click', (e)=>{
    const s = e.target.closest('[data-action="fa-sort"]');
    // Ensure this listener only works when the table is visible
    if (!s || !qs('#fa-tbody')) return;
    const key = s.getAttribute('data-key');
    if (sortKey === key) sortDir = (sortDir==='asc')?'desc':'asc'; else { sortKey = key; sortDir = 'asc'; }
    renderRows();
  });

  const newBtn = qs('#faction-new');
  if (newBtn) newBtn.addEventListener('click', () => openFactionForm());
}

async function openFactionDetail(id) {
  if (!id) return;
  if (!tokens.access) {
    handleUnauthorizedResponse('Please log in to view faction details.');
    return;
  }
  const res = await api(`/api/scales/factions/${id}/`);
  if (res.status === 401) return;
  if (!res.ok) { showMessage(`Load failed (${res.status})`, 'error'); return; }
  const f = await res.json();
  renderFactionDetailView(f);
}

function renderDiplomacyTags(names, directory = null, tone = 'allied') {
  if (!Array.isArray(names) || !names.length) return '';
  const byName = directory?.byName || new Map();
  return names.map((name) => {
    const info = byName.get(name);
    const label = escapeHtml(name);
    const cls = `diplo-tag ${tone}`;
    if (info && info.id !== undefined) {
      return `<button class="${cls}" data-action="scales-view" data-id="${info.id}">${label}</button>`;
    }
    return `<span class="${cls}">${label}</span>`;
  }).join('');
}

function renderFactionDetailView(f) {
  const area = qs('#abacus-content-area');
  area.classList.add('lineage-bg');
  const canEdit = ['HQ','PROTECTOR','HEIR'].includes(currentUser.role);
  const canDelete = canEdit;
  const emblem = (f.picture_url && String(f.picture_url).trim())
    ? `
    <button data-action="zoom-image" data-url="${escapeHtml(f.picture_url)}" class="block w-48 h-48 rounded-lg border border-gray-800 hover:border-gold-500/50 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 focus:ring-gold-500">
      <img src="${f.picture_url}" class="w-full h-full object-cover rounded-lg" onerror="this.src='https://placehold.co/320x320?text=Faction'; this.parentElement.disabled=true;">
    </button>
    `
    : `<div class="w-48 h-48 rounded-lg border border-dashed border-gray-700 flex items-center justify-center text-xs text-gray-500 mono">NO EMBLEM</div>`;

  area.innerHTML = `
    <div class="space-y-6 faction-profile lineage-dossier">
      <div class="flex flex-wrap items-start justify-between gap-3 cypher-header pb-4">
        <div class="flex-1 space-y-2">
          <h2 class="text-xl font-bold lineage-title tracking-widest truncate">
            <button data-action="scales-back" class="breadcrumb-link">THE SCALES</button>
            <span class="breadcrumb-sep">/</span>
            <span class="text-white">DOSSIER: ${escapeHtml(f.name)}</span>
          </h2>
          <span class="inline-flex items-center gap-2 px-3 py-1 rounded-full border cy-pill mono ${threatTierBadge(f.threat_level)}">
            <span class="inline-block h-2 w-2 rounded-full ${threatDotClass(f.threat_level)}"></span>
            ${f.threat_level || 'Dormant'}
          </span>
        </div>
        <div class="flex items-center gap-2">
          ${canEdit ? `<button class="terminal-btn-outline" data-action="scales-edit" data-id="${f.id}">EDIT</button>` : ''}
          ${canDelete ? `<button class="terminal-btn-outline" data-action="scales-del" data-id="${f.id}">DELETE</button>` : ''}
          <button class="terminal-btn-outline" data-action="scales-back">BACK</button>
        </div>
      </div>
      <hr class="page-divider mb-6">

      <div class="grid grid-cols-1 xl:grid-cols-[1.25fr,0.85fr] gap-6">
        <div class="space-y-4">
          <div>
            <h3 class="panel-title">» Overview</h3>
            <hr class="panel-divider my-2">
            <div id="fa-desc" class="text-gray-300 whitespace-pre-wrap font-serif">${multilineContent(f.description)}</div>
          </div>
          <div>
            <h3 class="panel-title">» SWOT Analysis</h3>
            <hr class="panel-divider my-2">
            <div class="grid grid-cols-2 gap-4">
              <div>
                <h4 class="diplomacy-label">Strengths</h4>
                ${formatListMarkup(parseDelimitedList(f.strengths), '// NO STRENGTHS DOCUMENTED')}
              </div>
              <div>
                <h4 class="diplomacy-label">Weaknesses</h4>
                ${formatListMarkup(parseDelimitedList(f.weaknesses), '// NO WEAKNESSES DOCUMENTED')}
              </div>
            </div>
          </div>
          <div>
            <h3 class="panel-title">» Member Roster</h3>
            <hr class="panel-divider my-2">
            <div class="space-y-2">
              <div class="flex items-center justify-between gap-3">
                ${canEdit ? `<button class="terminal-btn-outline text-xs" data-action="scales-manage-members" data-id="${f.id}" data-name="${escapeHtml(f.name || '')}">Manage Roster</button>` : '<span class="text-xs text-gray-500 mono">// VIEW ONLY</span>'}
                <div class="text-xs text-gray-500 mono" id="fa-roster-count">// ${(f.member_count ?? 0)} LINKED</div>
              </div>
              <div id="fa-roster-list" class="roster-list cy-scroll-slab" style="max-height: 360px;"><div class="text-gray-600 text-xs mono text-center py-6">// LOADING ROSTER…</div></div>
            </div>
          </div>
        </div>
        <div class="space-y-4">
          <div>
            <h3 class="panel-title">» Key Metrics</h3>
            <hr class="panel-divider my-2">
            <div class="grid grid-cols-1 gap-3 text-sm cy-metrics-grid">
              <div class="metric-cell">
                <div class="metric-label">Active Operations</div>
                <div class="metric-value mono" id="fa-ops-value">0</div>
              </div>
              <div class="metric-cell">
                <div class="metric-label">Known Allies</div>
                <div class="metric-value mono" id="fa-allies-value">${(f.allies || []).length}</div>
              </div>
            </div>
          </div>
          <div>
            <h3 class="panel-title">» Diplomacy</h3>
            <hr class="panel-divider my-2">
            <div class="space-y-4">
              <div>
                <div class="diplomacy-label allied">Allies</div>
                <div id="fa-ally-tags" class="diplomacy-tag-wrap"><span class="placeholder mono">// NO KNOWN ALLIES.</span></div>
              </div>
              <div>
                <div class="diplomacy-label rival">Rivals</div>
                <div id="fa-rival-tags" class="diplomacy-tag-wrap"><span class="placeholder mono">// NO KNOWN RIVALS.</span></div>
              </div>
            </div>
          </div>
          <div>
            <h3 class="panel-title">» Surveillance</h3>
            <hr class="panel-divider my-2">
            <div id="fa-surveillance-list" class="cy-scroll-slab" style="max-height: 240px;">
              ${parseDelimitedList(f.surveillance_urls).length
                ? `<ul class="space-y-2 text-sm text-emerald-300 mono">${parseDelimitedList(f.surveillance_urls).map((url, idx) => `<li><a class="underline hover:text-emerald-200" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">File ${idx + 1}</a></li>`).join('')}</ul>`
                : `<span class="text-xs text-gray-500 mono">// NO SURVEILLANCE FILES</span>`
              }
            </div>
          </div>
          <div>
            <h3 class="panel-title">» Profile History</h3>
            <hr class="panel-divider my-2">
            <div id="fa-history" class="cy-scroll-slab history-feed"><div class="cy-spinner"></div></div>
          </div>
        </div>
      </div>
      ${(['HQ','PROTECTOR','HEIR'].includes(currentUser.role) && (f.leverage_points||[]).length) ? `
        <div class="mt-4 leverage-locked rounded p-4 scanlines">
          <div class="flex items-center justify-between title"><div class="text-red-400 font-semibold glitch-red" data-text="Leverage ">Leverage </div><div class="text-xs restrict-label">Restricted: Visible to Heir, Protector, & HQ Only</div></div>
          <div class="content mt-2 leverage-content">
            <ul class="space-y-2">${(f.leverage_points||[]).map(lp=>`<li><span class="lv-text redacted" data-final="${(lp.description||'').replace(/"/g,'&quot;')} (${lp.potency||'High'})">████████</span></li>`).join('')}</ul>
            <div class="mt-3 text-right"><button id="lv-decrypt" class="px-3 py-2 rounded glass-btn red">Decrypt</button></div>
          </div>
        </div>` : ''}
    </div>`;

  animateMetricValue('#fa-ops-value', 0);

  const rosterListEl = qs('#fa-roster-list');
  const rosterCountEl = qs('#fa-roster-count');

  const updateRosterCount = (count = 0) => {
    if (rosterCountEl) rosterCountEl.textContent = `// ${count} LINKED`;
  };

  const rosterPlaceholder = (message) => {
    if (!rosterListEl) return;
    rosterListEl.innerHTML = `<div class="text-gray-600 text-xs mono text-center py-6">${escapeHtml(message)}</div>`;
  };

  const normaliseRosterEntries = (source = []) => {
    if (!Array.isArray(source)) return [];
    return source.map((item) => {
      const profile = item.profile || {};
      const profileId = Number(
        item.profile_id ??
        profile.id ??
        item.id ??
        null
      );
      if (!profileId || Number.isNaN(profileId)) return null;
      const fullName = item.full_name || profile.full_name || item.name || item.alias || 'Unknown Operative';
      const affiliation = item.affiliation || profile.affiliation || item.level || 'Associate';
      return {
        profile_id: profileId,
        full_name: fullName,
        affiliation,
      };
    }).filter(Boolean);
  };

  const renderRosterEntries = (entries = []) => {
    if (!rosterListEl) return;
    if (!entries.length) {
      rosterPlaceholder('// NO MEMBERS LINKED');
      updateRosterCount(0);
      return;
    }
    const sorted = [...entries].sort((a, b) => a.full_name.localeCompare(b.full_name));
    rosterListEl.innerHTML = sorted.map((entry) => `
      <div class="roster-list-entry flex items-center justify-between gap-3 border border-gray-800/60 bg-gray-950/60 hover:border-emerald-500/50 rounded px-3 py-2 transition">
        <button class="text-left flex-1 min-w-0 text-gray-100 hover:text-emerald-400 focus:text-emerald-400 truncate mono" data-action="idx-view" data-id="${entry.profile_id}">
          ${escapeHtml(entry.full_name)}
        </button>
        <span class="text-xs text-gray-400 mono">${escapeHtml(entry.affiliation || 'Associate')}</span>
      </div>`).join('');
    updateRosterCount(sorted.length);
  };

  const resolveLocalRoster = () => {
    const candidates = [f.roster, f.memberships, f.members];
    for (const dataset of candidates) {
      const normalized = normaliseRosterEntries(dataset);
      if (normalized.length) return normalized;
    }
    return [];
  };

  const localRoster = resolveLocalRoster();

  if (localRoster && localRoster.length) {
    renderRosterEntries(localRoster);
  } else if (rosterListEl) {
    rosterPlaceholder('// LOADING ROSTER…');
    if (canEdit) {
      (async () => {
        try {
          const res = await api(`/api/scales/factions/${f.id}/manage-members/`);
          if (!res.ok) {
            rosterPlaceholder(res.status === 403 ? '// ROSTER RESTRICTED' : '// FAILED TO LOAD ROSTER');
            updateRosterCount(f.member_count ?? 0);
            return;
          }
          const data = await res.json();
          const members = normaliseRosterEntries(data.members || []);
          if (members.length) renderRosterEntries(members);
          else {
            renderRosterEntries([]);
            updateRosterCount(f.member_count ?? 0);
          }
        } catch {
          rosterPlaceholder('// FAILED TO LOAD ROSTER');
          updateRosterCount(f.member_count ?? 0);
        }
      })();
    } else {
      rosterPlaceholder('// ROSTER RESTRICTED');
      updateRosterCount(f.member_count ?? 0);
    }
  }

  const allyContainer = qs('#fa-ally-tags');
  const rivalContainer = qs('#fa-rival-tags');
  const alliesList = f.allies || [];
  const rivalsList = f.rivals || [];
  animateMetricValue('#fa-allies-value', alliesList.length);

  (async () => {
    let directory = null;
    try {
      directory = await getFactionDirectory();
    } catch {
      directory = null;
    }
    const applyTags = (el, items, tone, placeholder) => {
      if (!el) return;
      if (!items.length) {
        el.innerHTML = `<span class="placeholder mono">${placeholder}</span>`;
        return;
      }
      el.innerHTML = renderDiplomacyTags(items, directory, tone);
    };
    applyTags(allyContainer, alliesList, 'allied', '// NO KNOWN ALLIES.');
    applyTags(rivalContainer, rivalsList, 'rival', '// NO KNOWN RIVALS.');
  })();

  // Timeline feed (icons based on source)
  (async () => {
    try {
      const r = await api(`/api/scales/factions/${f.id}/timeline/`);
      if (!r.ok) return;
      const items = await r.json();
      const box = qs('#fa-history');
      if (!box) return;
      if (!Array.isArray(items) || !items.length) {
        box.innerHTML = '<div class="history-empty text-gray-500">No recorded changes.</div>';
        animateMetricValue('#fa-ops-value', 0);
        return;
      }
      const historyHtml = items.map((it) => {
        const ts = formatTimestamp(it.timestamp);
        const role = (it.role || '').trim();
        const actor = (it.user || it.user_username || it.actor || '').trim();
        const metaBits = [ts];
        if (role) metaBits.push(role);
        if (actor && actor.toLowerCase() !== role.toLowerCase()) metaBits.push(actor);
        const meta = metaBits.filter(Boolean).join(' | ');
        const body = escapeHtml(it.text || '');
        return `<div class="history-item">
          <div class="history-meta mono">${escapeHtml(meta || ts)}</div>
          <div class="history-text text-sm text-gray-300">${body}</div>
        </div>`;
      }).join('');
      box.innerHTML = historyHtml;
      const operationCount = items.filter((it) => /operation/i.test(String(it.text || ''))).length;
      animateMetricValue('#fa-ops-value', operationCount);
    } catch {}
  })();

  // Decrypt Leverage content (leadership only)
  const decryptBtn = qs('#lv-decrypt');
  if (decryptBtn) {
    decryptBtn.addEventListener('click', () => {
      qsa('.lv-text').forEach((el) => {
        const finalText = el.getAttribute('data-final') || '';
        animateDecrypt(el, finalText);
      });
    });
  }
}

function renderFactionDetailEdit(f) {
  const area = qs('#abacus-content-area');
  const canEdit = ['HQ','PROTECTOR','HEIR'].includes(currentUser.role);
  if (!canEdit) { renderFactionDetailView(f); return; }

  area.innerHTML = `
    <div class="space-y-6 faction-profile lineage-dossier edit-mode">
      <div class="flex flex-wrap items-center justify-between gap-3 cypher-header pb-4">
        <div class="flex flex-wrap items-center gap-3">
          <input id="fe_name" class="terminal-input flex-1 min-w-[220px] text-2xl font-semibold text-gray-100 h1-glow" value="${(f.name||'').replace(/"/g,'&quot;')}" placeholder="Faction Name">
          ${renderCustomSelect('fe_threat', {'DORMANT':'Dormant','NOMINAL':'Nominal','ELEVATED':'Elevated','SEVERE':'Severe','CRITICAL':'Critical'}, f.threat_level || 'DORMANT')}
        </div>
            <div class="flex items-center gap-2">
              <button class="terminal-btn commit" data-action="scales-inline-save" data-id="${f.id}">// COMMIT</button>
              <button class="terminal-btn abort" data-action="scales-view" data-id="${f.id}">// ABORT</button>
            </div>
          </div>
      <hr class="page-divider mb-6">

      <div class="grid grid-cols-1 xl:grid-cols-[1.25fr,0.85fr] gap-6">
        <div class="space-y-6">
          <div>
            <h3 class="panel-title">» Overview</h3>
            <hr class="panel-divider my-2">
            ${sectionInput('fe_desc', f.description||'', 10, '', 'terminal-input cy-scroll-slab font-serif')}
          </div>
          <div>
            <h3 class="panel-title">» Strengths</h3>
            <hr class="panel-divider my-2">
            ${sectionInput('fe_str', parseDelimitedList(f.strengths).join(', '), 3, 'Comma-separated strengths', 'terminal-input mono')}
          </div>
          <div>
            <h3 class="panel-title">» Weaknesses</h3>
            <hr class="panel-divider my-2">
            ${sectionInput('fe_weak', parseDelimitedList(f.weaknesses).join(', '), 3, 'Comma-separated weaknesses', 'terminal-input mono')}
          </div>
        </div>
        <div class="space-y-6">
          <div>
            <h3 class="panel-title">» Diplomacy</h3>
            <hr class="panel-divider my-2">
            <div class="space-y-6 diplomacy-edit">
              <div>
                <div class="diplomacy-label allied">[ + Add Ally... ]</div>
                <div class="tag-editor" data-kind="allies">
                  <div id="fe-ally-tags" class="diplomacy-tag-wrap"></div>
                  <input id="fe-ally-input" class="tag-editor-input mono" placeholder="Type to search factions...">
                </div>
              </div>
              <div>
                <div class="diplomacy-label rival">[ + Add Rival... ]</div>
                <div class="tag-editor" data-kind="rivals">
                  <div id="fe-rival-tags" class="diplomacy-tag-wrap"></div>
                  <input id="fe-rival-input" class="tag-editor-input mono" placeholder="Type to search factions...">
                </div>
              </div>
            </div>
          </div>
          <div>
            <h3 class="panel-title">» Surveillance URLs</h3>
            <hr class="panel-divider my-2">
            ${sectionInput('fe_surveillance', parseDelimitedList(f.surveillance_urls).join(', '), 3, 'Comma-separated URLs', 'terminal-input mono')}
          </div>
          <div>
            <h3 class="panel-title">» Profile History</h3>
            <hr class="panel-divider my-2">
            <div id="fa-history" class="cy-scroll-slab history-feed"><div class="cy-spinner"></div></div>
          </div>
        </div>
    </div>`;

  animateMetricValue('#fa-members-value', f.member_count ?? 0);
  animateMetricValue('#fa-ops-value', 0);

  const alliesList = f.allies || [];
  const rivalsList = f.rivals || [];

  const tagEditors = {
    allies: {
      kind: 'allies',
      tone: 'allied',
      placeholder: '// NO KNOWN ALLIES.',
      list: [...alliesList],
      container: qs('#fe-ally-tags'),
      input: qs('#fe-ally-input')
    },
    rivals: {
      kind: 'rivals',
      tone: 'rival',
      placeholder: '// NO KNOWN RIVALS.',
      list: [...rivalsList],
      container: qs('#fe-rival-tags'),
      input: qs('#fe-rival-input')
    }
  };

  const syncDraft = () => {
    currentDiplomacyDraft = {
      allies: [...tagEditors.allies.list],
      rivals: [...tagEditors.rivals.list]
    };
  };
  syncDraft(); // Initial sync

  const renderEditor = (editor) => {
    const { container, list, tone, placeholder, kind } = editor;
    if (!container) return;
    if (!list.length) {
      container.innerHTML = `<span class="placeholder mono">${placeholder}</span>`;
      return;
    }
    container.innerHTML = list.map((name, idx) => `
      <span class="diplo-tag ${tone}" data-role="tag" data-kind="${kind}" data-index="${idx}">
        ${escapeHtml(name)}
        <button type="button" class="tag-remove" data-role="tag-remove" data-kind="${kind}" data-index="${idx}" aria-label="Remove ${escapeHtml(name)}">×</button>
      </span>`).join('');
  };

  const addTag = (editor, raw) => {
    const value = resolveFactionName(raw);
    if (!value) return;
    if (editor.list.some((n) => n.toLowerCase() === value.toLowerCase())) return;
    editor.list.push(value);
    renderEditor(editor);
    syncDraft();
    if (editor.updateSuggestions) editor.updateSuggestions();
  };

  const removeTag = (editor, index) => {
    if (index < 0 || index >= editor.list.length) return;
    editor.list.splice(index, 1);
    renderEditor(editor);
    syncDraft();
    if (editor.updateSuggestions) editor.updateSuggestions();
  };

  Object.values(tagEditors).forEach((editor) => {
    renderEditor(editor);
    if (editor.input) {
      editor.input.addEventListener('keydown', (ev) => {
        if (['Enter', 'Tab', ','].includes(ev.key)) {
          ev.preventDefault();
          const value = editor.input.value.trim();
          if (value) {
            ev.preventDefault();
            addTag(editor, value);
            editor.input.value = '';
          }
        } else if (ev.key === 'Backspace' && !editor.input.value && editor.list.length) {
          ev.preventDefault();
          removeTag(editor, editor.list.length - 1);
        }
      });
      editor.input.addEventListener('blur', () => {
        const value = editor.input.value.trim();
        if (value) addTag(editor, value);
        editor.input.value = '';
      });
    }
    if (editor.container) {
      editor.container.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-role="tag-remove"]');
        if (!btn) return;
        const idx = Number(btn.getAttribute('data-index'));
        if (!Number.isNaN(idx)) removeTag(editor, idx);
      });
    }
  });

  const setupTagSuggestions = (editor, names) => {
    const input = editor.input;
    const wrap = editor.container?.parentElement;
    if (!input || !wrap || !Array.isArray(names) || !names.length) return;
    wrap.classList.add('tag-editor-wrap');
    const panel = document.createElement('div');
    panel.className = 'tag-suggestions hidden';
    wrap.appendChild(panel);

    let pointer = -1;

    const render = (items) => {
      if (!items.length) {
        panel.innerHTML = '';
        panel.classList.add('hidden');
        return;
      }
      pointer = Math.min(pointer, items.length - 1);
      panel.innerHTML = items.map((name, idx) => `
        <button type="button" class="tag-suggestion${idx === pointer ? ' active' : ''}" data-name="${name.replace(/"/g, '&quot;')}">${escapeHtml(name)}</button>`).join('');
      panel.classList.remove('hidden');
    };

    const update = () => {
      const term = (input.value || '').trim().toLowerCase();
      const existing = new Set(editor.list.map((n) => n.toLowerCase()));
      const results = names
        .filter((n) => !existing.has(n.toLowerCase()))
        .filter((n) => !term || n.toLowerCase().includes(term))
        .slice(0, 8);
      render(results);
    };

    editor.updateSuggestions = update;

    panel.addEventListener('mousedown', (ev) => ev.preventDefault());
    panel.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-name]');
      if (!btn) return;
      const value = btn.getAttribute('data-name') || '';
      if (value) addTag(editor, value);
      input.value = '';
      update();
    });

    input.addEventListener('input', () => {
      pointer = -1;
      update();
    });
    input.addEventListener('focus', () => {
      pointer = -1;
      update();
    });
    input.addEventListener('keydown', (ev) => {
      const visible = !panel.classList.contains('hidden');
      if (!visible) return;
      const buttons = Array.from(panel.querySelectorAll('.tag-suggestion'));
      if (!buttons.length) return;
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        pointer = (pointer + 1) % buttons.length;
        buttons.forEach((btn, idx) => btn.classList.toggle('active', idx === pointer));
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        pointer = (pointer <= 0 ? buttons.length : pointer) - 1;
        buttons.forEach((btn, idx) => btn.classList.toggle('active', idx === pointer));
      } else if (ev.key === 'Enter') {
        if (pointer >= 0 && pointer < buttons.length) {
          ev.preventDefault();
          buttons[pointer].click();
        }
      } else if (ev.key === 'Escape') {
        panel.classList.add('hidden');
      }
    });
    input.addEventListener('blur', () => {
      setTimeout(() => panel.classList.add('hidden'), 120);
    });
  };

  (async () => {
    try {
      const directory = await getFactionDirectory();
      const names = (directory.list || [])
        .map((item) => String(item?.name || '').trim())
        .filter(Boolean)
        .filter(name => name.toLowerCase() !== (f.name || '').toLowerCase());
      Object.values(tagEditors).forEach((editor) => setupTagSuggestions(editor, names));
    } catch {}
  })();

  // Timeline feed (icons based on source)
  (async () => {
    try {
      const r = await api(`/api/scales/factions/${f.id}/timeline/`);
      if (!r.ok) return;
      const items = await r.json();
      const box = qs('#fa-history');
      if (!box) return;
      if (!Array.isArray(items) || !items.length) {
        box.innerHTML = '<div class="history-empty text-gray-500">No recorded changes.</div>';
        animateMetricValue('#fa-ops-value', 0);
        return;
      }
      const historyHtml = items.map((it) => {
        const ts = formatTimestamp(it.timestamp);
        const role = (it.role || '').trim();
        const actor = (it.user || it.user_username || it.actor || '').trim();
        const metaBits = [ts];
        if (role) metaBits.push(role);
        if (actor && actor.toLowerCase() !== role.toLowerCase()) metaBits.push(actor);
        const meta = metaBits.filter(Boolean).join(' | ');
        const body = escapeHtml(it.text || '');
        return `<div class="history-item">
          <div class="history-meta mono">${escapeHtml(meta || ts)}</div>
          <div class="history-text text-sm text-gray-300">${body}</div>
        </div>`;
      }).join('');
      box.innerHTML = historyHtml;
      const operationCount = items.filter((it) => /operation/i.test(String(it.text || ''))).length;
      animateMetricValue('#fa-ops-value', operationCount);
    } catch {}
  })();

}

function openFactionForm(existing = null) {
  const isEdit = !!existing;
  const title = isEdit ? 'Edit Faction' : 'New Faction';
  const vals = Object.assign({
    name: '',
    threat_level: 'DORMANT',
    picture_url: '',
    description: '',
    strengths: '',
    weaknesses: '',
    allies: [],
    rivals: []
  }, existing || {});

  const field = (title, input) => `<div><h3 class="panel-title text-sm">${title}</h3><hr class="panel-divider my-2">${input}</div>`;
  const toCSV = (arr) => (Array.isArray(arr) ? arr.join(', ') : arr || '');

  const html = `
    <div class="cy-panel rounded-lg overflow-hidden" style="min-width: 720px;">
      <div class="modal-title py-3 border-b border-gray-800 bg-gray-950/70">
        <div class="text-lg font-semibold text-gray-100 tracking-wide mono px-4">» ${escapeHtml(title)}</div>
      </div>
      <div class="modal-body p-4 bg-gray-950/40 space-y-4 cy-scroll-slab" style="max-height: 70vh;">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          ${field('» Faction Name', `<input id="ff_name" class="terminal-input w-full" value="${vals.name || ''}">`)}
          ${field('» Threat Level', `<select id="ff_threat" class="terminal-input w-full">${['DORMANT', 'NOMINAL', 'ELEVATED', 'SEVERE', 'CRITICAL'].map(v => `<option value="${v}" ${v === vals.threat_level ? 'selected' : ''}>${v.charAt(0) + v.slice(1).toLowerCase()}</option>`).join('')}</select>`)}
        </div>
        ${field('» Description', `<textarea id="ff_desc" rows="4" class="terminal-input w-full font-serif">${vals.description || ''}</textarea>`)}
        ${field('» Strengths (comma-separated)', `<textarea id="ff_str" rows="2" class="terminal-input w-full mono">${toCSV(vals.strengths)}</textarea>`)}
        ${field('» Weaknesses (comma-separated)', `<textarea id="ff_weak" rows="2" class="terminal-input w-full mono">${toCSV(vals.weaknesses)}</textarea>`)}
      </div>
      <footer class="py-3 border-t border-gray-800 bg-gray-950/70 flex justify-end gap-3 px-4">
        <button data-action="close-modal" class="terminal-btn abort">// CANCEL</button>
        <button id="faction-save" class="terminal-btn commit">// SAVE</button>
      </footer>
    </div>
  `;
  openModal(html);

  qs('#faction-save').addEventListener('click', async () => {
    const payload = {
      name: qs('#ff_name').value.trim(),
      threat_level: qs('#ff_threat').value,
      description: qs('#ff_desc').value.trim(),
      strengths: qs('#ff_str').value.trim(),
      weaknesses: qs('#ff_weak').value.trim(),
    };

    if (!payload.name) {
      showMessage('Faction name is required', 'error');
      return;
    }

    const url = '/api/scales/factions/' + (isEdit ? `${existing.id}/` : '');
    const method = isEdit ? 'PATCH' : 'POST';
    const res = await api(url, { method, body: JSON.stringify(payload) });
    if (!res.ok) { showMessage(`Save failed (${res.status})`, 'error'); return; }
    closeModal();
    try { await getFactionDirectory(true); } catch { invalidateFactionDirectory(); }
    const data = await loadFactions();
    renderFactionsList(data);
  });
}

// Save inline faction edits
document.addEventListener('click', async (e)=>{
  const btn = e.target.closest('[data-action="scales-inline-save"]');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  const payload = {
    name: qs('#fe_name')?.value?.trim() || '',
    threat_level: qs('#fe_threat')?.value || 'DORMANT',
    description: qs('#fe_desc')?.value || '',
    strengths: qs('#fe_str')?.value || '',
    weaknesses: qs('#fe_weak')?.value || '',
    allies: (currentDiplomacyDraft.allies || []).join(', '),
    rivals: (currentDiplomacyDraft.rivals || []).join(', '),
    surveillance_urls: qs('#fe_surveillance')?.value || '',
  };
  if (!payload.name) {
    showMessage('Faction name is required', 'error');
    return;
  }
  btn.disabled = true;
  btn.classList.add('busy');
  try {
    const res = await api(`/api/scales/factions/${id}/`, { method: 'PATCH', body: JSON.stringify(payload) });
    if (!res.ok) {
      showMessage('Save failed', 'error');
      return;
    }
    showMessage('Faction updated', 'info');
    try { await getFactionDirectory(true); } catch { invalidateFactionDirectory(); }
    openFactionDetail(id);
  } catch (err) {
    console.error(err);
    showMessage('Save failed', 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
  }
});

function openManageMembersModal(factionId, factionName = '') {
  const AFFILIATION_DEFAULTS = [
    'Leader', 
    'High ranking member', 
    'Member', 
    'Associate', 
    'Hangaround', 
    'Affiliate', 
    'Supporter', 
    'Informant', 
    'Unknown'
  ];
  let affiliationOptions = [...AFFILIATION_DEFAULTS];
  const rosterState = new Map();
  let candidateCache = [];
  let searchTerm = '';
  let searchTimer = null;

  const safeName = escapeHtml(factionName || '');
  const title = safeName ? `Manage Roster: ${safeName}` : 'Manage Roster';
  const html = `
    <div class="manage-roster-modal cy-panel rounded-lg overflow-hidden" style="min-width: 960px;">
      <div class="modal-title py-4 border-b border-gray-800 flex items-center justify-between bg-gray-950/70">
        <div class="text-lg font-semibold text-gray-100 tracking-wide mono">» ${title}</div>
        <div class="text-xs uppercase text-gray-500 mono">Terminal Access // Scales.OS</div>
      </div>
      <div class="modal-body grid grid-cols-1 lg:grid-cols-2 gap-4 py-4 bg-gray-950/40">
        <section class="roster-column flex flex-col gap-3">
          <header class="flex items-center justify-between">
            <div class="text-sm text-gray-300 tracking-wide mono">» CURRENT MEMBERS</div>
            <div class="text-xs text-gray-500 mono">// <span id="mm-member-count">0</span> LINKED</div>
          </header>
          <div id="mm-current" class="roster-manage-list cy-scroll-slab bg-gray-900/40 border border-gray-800 rounded p-3 space-y-2 overflow-y-auto" style="max-height: 420px;"></div>
        </section>
        <section class="roster-column flex flex-col gap-3">
          <header class="flex flex-col gap-2">
            <div class="text-sm text-gray-300 tracking-wide mono">» ADD MEMBER FROM THE INDEX</div>
            <input id="mm-search" class="w-full px-3 py-2 rounded bg-gray-950 border border-gray-800 text-gray-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/60 mono placeholder:text-gray-500" placeholder="Search The Index…" autocomplete="off" autocapitalize="none" spellcheck="false">
          </header>
          <div id="mm-candidates" class="roster-manage-list cy-scroll-slab bg-gray-900/40 border border-gray-800 rounded p-3 space-y-2 text-sm text-gray-400 overflow-y-auto mono" style="max-height: 420px;">Start typing to search The Index…</div>
        </section>
      </div>
      <footer class="py-4 border-t border-gray-800 bg-gray-950/70 flex justify-end gap-3">
        <button data-action="close-modal" class="terminal-btn abort">// ABORT</button> 
        <button id="mm-save" class="terminal-btn commit disabled:opacity-50" disabled>// COMMIT</button>
      </footer>
    </div>`;
  openModal(html);

  const currentList = qs('#mm-current');
  const currentCount = qs('#mm-member-count');
  const candidateList = qs('#mm-candidates');
  const searchInput = qs('#mm-search');
  const saveBtn = qs('#mm-save');

  const normaliseAffiliation = (value) => {
    if (affiliationOptions.includes(value)) return value;
    return affiliationOptions[0] || 'Associate';
  };

  const renderAffiliationOptions = (selected) => affiliationOptions
    .map(opt => `<option value="${opt}" ${opt === selected ? 'selected' : ''}>${opt}</option>`)
    .join('');

  const activeMembers = () => Array.from(rosterState.values()).filter(entry => !entry.isRemoved);

  const hasChanges = () => {
    for (const entry of rosterState.values()) {
      if (entry.isNew && !entry.isRemoved) return true; // A new member was added
      if (!entry.isNew && entry.isRemoved) return true; // An existing member was removed
      if (!entry.isNew && !entry.isRemoved && entry.affiliation !== entry.originalAffiliation) return true; // An existing member was updated
    }
    return false;
  };

  const updateSaveState = () => {
    const changed = hasChanges();
    saveBtn.disabled = !changed;
    saveBtn.classList.toggle('disabled', !changed);
    saveBtn.setAttribute('aria-disabled', String(!changed));
  };

  const formatAliases = (aliases) => {
    const records = Array.isArray(aliases) ? aliases.filter(Boolean) : [];
    if (!records.length) return '';
    return `<div class="roster-manage-aliases text-xs text-emerald-400/80 mono truncate">AKA: ${escapeHtml(records.join(', '))}</div>`;
  };

  const toggleCandidateActions = (card, show) => {
    if (!card) return;
    const actions = card.querySelector('.roster-candidate-actions');
    if (!actions) return;
    actions.style.opacity = show ? '1' : '0';
    actions.style.pointerEvents = show ? 'auto' : 'none';
  };

  const renderMembers = () => {
    const members = activeMembers().sort((a, b) => a.full_name.localeCompare(b.full_name));
    currentCount.textContent = String(members.length);
    if (!members.length) {
      currentList.innerHTML = '<div class="text-gray-600 text-xs mono tracking-wide text-center py-6">// NO MEMBERS LINKED</div>';
      return;
    }
    currentList.innerHTML = members.map(entry => `
      <div class="roster-manage-item flex items-center gap-3 bg-gray-950/70 border border-gray-800/80 rounded px-3 py-2 hover:border-emerald-500/50 transition" data-id="${entry.profile_id}">
        <div class="flex-1 min-w-0">
          <div class="roster-manage-name text-sm text-gray-100 truncate mono">${escapeHtml(entry.full_name)}</div>
          ${formatAliases(entry.aliases)}
        </div>
        <div class="roster-manage-controls flex items-center gap-2">
          <select class="roster-manage-select bg-gray-950 border border-gray-800 text-gray-100 text-xs px-2 py-1 rounded mono focus:ring-emerald-500/50" data-role="member-aff" data-id="${entry.profile_id}">
            ${renderAffiliationOptions(entry.affiliation)}
          </select>
          <button class="roster-remove-btn text-rose-400 hover:text-rose-300 text-sm px-2" data-role="member-remove" data-id="${entry.profile_id}" aria-label="Remove from roster">✕</button>
        </div>
      </div>`).join('');
  };

  const renderCandidates = () => {
    if (!searchTerm) {
      candidateList.innerHTML = '<div class="text-gray-600 text-xs mono tracking-wide text-center py-6">Start typing to search The Index…</div>';
      return;
    }
    if (!candidateCache.length) {
      candidateList.innerHTML = '<div class="text-gray-600 text-xs mono tracking-wide text-center py-6">// NO MATCHING PROFILES</div>';
      return;
    }
    candidateList.innerHTML = candidateCache.map(cand => `
      <div class="roster-candidate flex flex-col gap-2 bg-gray-950/60 border border-gray-800/80 rounded px-3 py-2 transition hover:border-emerald-500/50" data-id="${cand.profile_id}">
        <div class="flex items-start justify-between gap-3">
          <div class="flex-1 min-w-0">
            <div class="text-sm text-gray-100 mono truncate">${escapeHtml(cand.full_name)}</div>
            ${formatAliases(cand.aliases)}
          </div>
          <div class="text-[10px] text-gray-500 uppercase mono tracking-wide">INDEX #${cand.profile_id}</div>
        </div>
        <div class="roster-candidate-actions flex items-center gap-2" style="opacity:0; pointer-events:none; transition: opacity 180ms ease;">
          <select class="bg-gray-950 border border-gray-800 text-gray-100 text-xs px-2 py-1 rounded mono focus:ring-emerald-500/50" data-role="candidate-aff" data-id="${cand.profile_id}">
            ${renderAffiliationOptions(cand.affiliation || AFFILIATION_DEFAULTS[0])}
          </select>
          <button class="roster-add-btn text-emerald-400 hover:text-emerald-300 text-xs px-3 py-1 border border-emerald-500/40 rounded mono tracking-wide" data-role="candidate-add" data-id="${cand.profile_id}">+ ADD</button>
        </div>
      </div>`).join('');
  };

  const applyInitialData = (data) => {
    if (Array.isArray(data.affiliation_options) && data.affiliation_options.length) {
      affiliationOptions = data.affiliation_options;
    } else {
      affiliationOptions = [...AFFILIATION_DEFAULTS];
    }
    rosterState.clear();
    (data.members || []).forEach(mem => {
      const profileId = Number(mem.profile_id);
      const cleanAff = normaliseAffiliation(mem.affiliation);
      rosterState.set(profileId, {
        profile_id: profileId,
        full_name: mem.full_name || 'Unknown Operative',
        aliases: mem.aliases || [],
        affiliation: cleanAff,
        originalAffiliation: cleanAff,
        isNew: false,
        isRemoved: false,
      });
    });
    candidateCache = [];
    searchTerm = '';
    if (searchInput) searchInput.value = '';
    renderMembers();
    renderCandidates();
    updateSaveState();
  };

  const loadInitial = async () => {
    try {
      const res = await api(`/api/scales/factions/${factionId}/manage-members/`);
      if (!res.ok) { showMessage('Failed to load roster data', 'error'); return; }
      const data = await res.json();
      applyInitialData(data);
    } catch {
      showMessage('Failed to load roster data', 'error');
    }
  };
  loadInitial();

  const loadCandidates = async (term) => {
    searchTerm = term;
    if (!term) {
      candidateCache = [];
      renderCandidates();
      return;
    }
    try {
      const res = await api(`/api/scales/factions/${factionId}/manage-members/?q=${encodeURIComponent(term)}`);
      if (!res.ok) return;
      const data = await res.json();
      const incoming = Array.isArray(data.candidates) ? data.candidates : [];
      candidateCache = incoming
        .map(c => ({
          profile_id: Number(c.profile_id),
          full_name: c.full_name || 'Unknown Operative',
          aliases: c.aliases || [],
          affiliation: normaliseAffiliation(c.affiliation || 'Associate'),
        }))
        .filter(c => {
          const existing = rosterState.get(c.profile_id);
          return !(existing && !existing.isRemoved);
        });
      renderCandidates();
    } catch {}
  };

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const term = e.target.value.trim();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadCandidates(term), 250);
    });
  }

  candidateList.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.roster-candidate');
    if (!card || !candidateList.contains(card)) return;
    toggleCandidateActions(card, true);
  });

  candidateList.addEventListener('mouseout', (e) => {
    const card = e.target.closest('.roster-candidate');
    if (!card || !candidateList.contains(card)) return;
    const related = e.relatedTarget;
    if (related && card.contains(related)) return;
    toggleCandidateActions(card, false);
  });

  currentList.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-role="member-aff"]');
    if (!sel) return;
    const profileId = Number(sel.getAttribute('data-id'));
    const entry = rosterState.get(profileId);
    if (!entry) return;
    entry.affiliation = sel.value;
    updateSaveState();
  });

  currentList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-role="member-remove"]');
    if (!btn) return;
    const profileId = Number(btn.getAttribute('data-id'));
    const entry = rosterState.get(profileId);
    if (!entry) return;
    if (entry.isNew) {
      rosterState.delete(profileId);
    } else {
      entry.isRemoved = true;
    }
    renderMembers();
    updateSaveState();
  });

  candidateList.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-role="candidate-aff"]');
    if (!sel) return;
    const profileId = Number(sel.getAttribute('data-id'));
    // Enable the add button once an affiliation is selected
    const addButton = sel.nextElementSibling;
    if (addButton && addButton.matches('[data-role="candidate-add"]')) {
        addButton.disabled = !sel.value;
    }
    const candidate = candidateCache.find(c => c.profile_id === profileId);
    if (candidate) candidate.affiliation = sel.value;
  });

  candidateList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-role="candidate-add"]');
    if (!btn) return;
    const profileId = Number(btn.getAttribute('data-id'));
    const candidate = candidateCache.find(c => c.profile_id === profileId);
    if (!candidate) return;
    const affSelect = btn.previousElementSibling;
    const selectedAff = (affSelect && affSelect.value) || candidate.affiliation || normaliseAffiliation('Associate');
    if (!selectedAff) {
        return; // Do not add if no affiliation is selected
    }
    const existing = rosterState.get(profileId);
    if (existing) {
      existing.isRemoved = false;
      existing.affiliation = selectedAff;
    } else {
      rosterState.set(profileId, {
        profile_id: profileId,
        full_name: candidate.full_name,
        aliases: candidate.aliases || [],
        affiliation: selectedAff,
        originalAffiliation: selectedAff,
        isNew: true,
        isRemoved: false,
      });
    }
    candidateCache = candidateCache.filter(c => c.profile_id !== profileId);
    renderMembers();
    renderCandidates();
    updateSaveState();
  });

  saveBtn.addEventListener('click', async () => {
    const add = [];
    const updates = [];
    const remove = [];
    for (const entry of rosterState.values()) {
      if (entry.isNew && !entry.isRemoved) {
        // This is a newly added member.
        add.push({ profile_id: entry.profile_id, affiliation: entry.affiliation });
      } else if (entry.isRemoved && !entry.isNew) {
        // This is an original member that was marked for removal.
        remove.push(entry.profile_id);
      } else {
        if (entry.affiliation !== entry.originalAffiliation) {
          updates.push({ profile_id: entry.profile_id, affiliation: entry.affiliation });
        }
      }
    };

    if (!add.length && !updates.length && !remove.length) {
      showMessage('No roster changes to save.', 'info');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.classList.add('busy');
    try {
      const res = await api(`/api/scales/factions/${factionId}/manage-members/`, {
        method: 'POST',
        body: JSON.stringify({ add, updates, remove })
      });
      if (!res.ok) {
        showMessage('Failed to update roster.', 'error');
        return;
      }
      showMessage('Roster updated.', 'info');
      closeModal();
      openFactionDetail(factionId);
    } catch (err) {
      showMessage('Failed to update roster.', 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.classList.remove('busy');
    }
  });

}
// ===== The Silo UI (Report Submission & Viewing) =====

const SILO_STATUS_LABELS = {
  PENDING: 'New',
  UNDER_REVIEW: 'Under Review',
  ACTIONED: 'Actioned',
  PROMOTED: 'Actioned', // Observers don't need to know the difference
  DISMISSED: 'Dismissed',
};

const SILO_CONFIDENCE_LEVELS = {
  DIRECT: 'Direct Observation',
  VERIFIED: 'Verified Informant',
  CORROBORATED: 'Corroborated Rumor',
  UNVERIFIED: 'Unverified Tip',
};

async function loadMySiloReports() {
  const res = await api('/api/codex/echoes/');
  if (!res.ok) throw new Error(`Failed to load your reports (${res.status})`);
  return res.json();
}

function timeAgo(date) {
    const seconds = Math.floor((new Date() - new Date(date)) / 1000);
    let interval = seconds / 31536000;
    if (interval > 1) return Math.floor(interval) + " years ago";
    interval = seconds / 2592000;
    if (interval > 1) return Math.floor(interval) + " months ago";
    interval = seconds / 86400;
    if (interval > 1) return Math.floor(interval) + " days ago";
    interval = seconds / 3600;
    if (interval > 1) return Math.floor(interval) + " hours ago";
    interval = seconds / 60;
    if (interval > 1) return Math.floor(interval) + " minutes ago";
    return Math.floor(seconds) + " seconds ago";
}

function renderSiloList(reports) {
  const area = qs('#abacus-content-area');
  if (!area) return;
  area.className = 'flex-1 p-4 md:p-6 overflow-y-auto transition-colors duration-500 lineage-bg';

  const reportRows = reports.map(r => `
    <tr class="border-t border-gray-800 hover:bg-gold-900/10">
      <td class="px-4 py-2 font-medium text-gray-100"><button class="text-left hover:underline" data-action="silo-view-report" data-id="${r.id}">${escapeHtml(r.title)}</button></td>
      <td class="px-4 py-2 text-gray-400 mono">${timeAgo(r.created_at)}</td>
      <td class="px-4 py-2"><span class="inline-block px-2 py-0.5 rounded bg-gray-800 border border-gray-700 text-gray-300 mono">${SILO_STATUS_LABELS[r.status] || r.status}</span></td>
    </tr>
  `).join('');

  area.innerHTML = `
    <div class="mb-4 flex items-center justify-between gap-3">
      <h2 class="text-xl font-bold lineage-title tracking-widest">MY REPORTS</h2>
      <button class="terminal-btn commit" data-action="silo-new-report">» FILE REPORT</button>
    </div>
    <div class="overflow-x-auto panel">
      <table class="min-w-full text-left text-sm">
        <thead class="text-gold-400">
          <tr>
            <th class="px-4 py-2">Title</th>
            <th class="px-4 py-2">Submitted</th>
            <th class="px-4 py-2">Status</th>
          </tr>
        </thead>
        <tbody class="text-gray-200">
          ${reportRows || `<tr><td colspan="3" class="text-center py-8 text-gray-500 mono">// NO REPORTS SUBMITTED</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function renderSiloSubmitForm() {
  const area = qs('#abacus-content-area');
  if (!area) return;
  area.className = 'flex-1 p-4 md:p-6 overflow-y-auto transition-colors duration-500 lineage-bg';

  area.innerHTML = `
    <div class="silo-submit-form max-w-4xl mx-auto">
      <div class="flex items-center justify-between gap-3 mb-4">
        <h2 class="text-xl font-bold lineage-title tracking-widest">SECURE TRANSMISSION</h2>
        <button class="terminal-btn abort" data-action="silo-back-to-list">// CANCEL</button>
      </div>
      <div class="panel p-6 space-y-6">
        <div>
          <label class="form-label-gold">» Report Title</label>
          <input id="silo_title" class="form-input-gold w-full" type="text" placeholder="e.g., Suspicious Activity at Pier 4">
        </div>
        <div>
          <label class="form-label-gold">» Source Confidence</label>
          ${renderCustomSelect('silo_confidence', SILO_CONFIDENCE_LEVELS, 'DIRECT')}
        </div>
        <div>
          <label class="form-label-gold">» Involved Entities (Tag Profiles & Factions)</label>
          <div class="tag-editor-wrapper">
            <div id="silo_entities_editor" class="tag-editor-gold">
              <div id="silo_entity_tags" class="flex flex-wrap gap-2"></div>
              <input id="silo_entity_search" class="tag-editor-input-gold" placeholder="Type to search Index or Scales...">
            </div>
            <div id="silo_entity_results" class="tag-suggestions hidden"></div>
          </div>
        </div>
        <div>
          <label class="form-label-gold">» Detailed Briefing</label>
          <textarea id="silo_content" class="form-input-gold w-full h-48 cy-scroll-slab" placeholder="Provide a full account of the intelligence..."></textarea>
        </div>
        <div>
          <label class="form-label-gold">» Attach Evidence (Comma-separated URLs)</label>
          <textarea id="silo_evidence" class="form-input-gold w-full h-24 cy-scroll-slab" placeholder="https://example.com/image.jpg, https://example.com/document.pdf"></textarea>
        </div>
        <div class="pt-4 text-center">
          <button data-action="silo-submit" class="terminal-btn-solid-gold text-lg px-8 py-3">// TRANSMIT SECURELY</button>
        </div>
      </div>
    </div>
  `;

  setupEntityTagging();
}

function setupEntityTagging() {
  const editor = qs('#silo_entities_editor');
  const tagsContainer = qs('#silo_entity_tags');
  const searchInput = qs('#silo_entity_search');
  const resultsContainer = qs('#silo_entity_results');
  let searchTimer = null;

  const addTag = (type, id, name) => {
    const existing = qsa(`#silo_entity_tags [data-id="${id}"][data-type="${type}"]`);
    if (existing.length > 0) return; // Don't add duplicates

    const tag = document.createElement('span');
    tag.className = `diplo-tag ${type === 'profile' ? 'allied' : 'rival'}`;
    tag.dataset.type = type;
    tag.dataset.id = id;
    tag.dataset.name = name;
    tag.innerHTML = `${type === 'profile' ? '👤' : '⚖️'} ${escapeHtml(name)} <button type="button" class="tag-remove" aria-label="Remove">×</button>`;
    tagsContainer.appendChild(tag);
  };

  tagsContainer.addEventListener('click', e => {
    if (e.target.classList.contains('tag-remove')) {
      e.target.parentElement.remove();
    }
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const query = searchInput.value.trim();
    if (query.length < 2) {
      resultsContainer.innerHTML = '';
      hide(resultsContainer);
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const [profilesRes, factionsRes] = await Promise.all([
          api(`/api/index/profiles/?q=${encodeURIComponent(query)}`),
          api(`/api/scales/factions/?search=${encodeURIComponent(query)}`)
        ]);
        const profiles = await profilesRes.json();
        const factions = await factionsRes.json();

        const profileResults = profiles.map(p => `<button class="tag-suggestion" data-type="profile" data-id="${p.id}" data-name="${escapeHtml(p.full_name)}">👤 ${escapeHtml(p.full_name)}</button>`).join('');
        const factionResults = factions.map(f => `<button class="tag-suggestion" data-type="faction" data-id="${f.id}" data-name="${escapeHtml(f.name)}">⚖️ ${escapeHtml(f.name)}</button>`).join('');

        if (profileResults || factionResults) {
          resultsContainer.innerHTML = profileResults + factionResults;
          show(resultsContainer);
        } else {
          hide(resultsContainer);
        }
      } catch (e) {
        console.error("Entity search failed:", e);
        hide(resultsContainer);
      }
    }, 300);
  });

  resultsContainer.addEventListener('click', e => {
    const btn = e.target.closest('button.tag-suggestion');
    if (!btn) return;
    addTag(btn.dataset.type, btn.dataset.id, btn.dataset.name);
    searchInput.value = '';
    hide(resultsContainer);
    searchInput.focus();
  });

  document.addEventListener('click', e => {
    if (!editor.contains(e.target)) {
      hide(resultsContainer);
    }
  });
}

// Centralized event handler for the Silo module
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action^="silo-"]');
  if (!btn) return;

  const action = btn.getAttribute('data-action');
  switch (action) {
    case 'silo-new-report':
      renderSiloSubmitForm(); // This now correctly renders the form view
      break;
    case 'silo-back-to-list':
      handleNavigation('silo');
      break;
    case 'silo-view-triage':
        loadAndRenderSiloLeadershipDashboard('triage');
        break;
    case 'silo-view-archive':
        loadAndRenderSiloLeadershipDashboard('archive');
        break;
    case 'silo-view-report':
        openSiloReportDetail(btn.dataset.id);
        break;
    case 'silo-add-comment': {
        const reportId = btn.dataset.id;
        const textarea = qs('#silo-new-comment');
        const message = textarea.value.trim();
        if (!message) return;

        try {
            const res = await api(`/api/codex/echoes/${reportId}/comments/`, {
                method: 'POST',
                body: JSON.stringify({ message })
            });
            if (!res.ok) throw new Error('Failed to add comment');
            // Refresh the detail view to show the new comment
            openSiloReportDetail(reportId);
        } catch (err) {
            showMessage(err.message, 'error');
        }
        break;
    }
    case 'silo-create-task':
        showMessage('Feature: Create Task from report (coming soon).', 'info');
        break;
    case 'silo-launch-op': {
        const reportId = btn.dataset.id;
        const reportRes = await api(`/api/codex/echoes/${reportId}/`);
        if (!reportRes.ok) { showMessage('Failed to load report data.', 'error'); return; }
        const report = await reportRes.json();
        const prefill = { codename: report.title, objectives: report.content };
        openLaunchOperationModal(prefill);
        break;
    }
    case 'silo-attach-to-op': {
        const reportId = btn.dataset.id;
        openAttachToOperationModal(reportId);
        break;
    }
    case 'silo-attach-to-op-from-loom': {
        const reportId = btn.dataset.id;
        openAttachToOperationModal(reportId);
        break;
    }
    case 'silo-submit': {
      const payload = {
        title: qs('#silo_title')?.value.trim(),
        confidence: qs('#silo_confidence')?.value,
        content: qs('#silo_content')?.value.trim(),
        evidence_urls: qs('#silo_evidence')?.value.trim(),
        involved_entities: Array.from(qs('#silo_entity_tags')?.children || []).map(tag => ({
          type: tag.dataset.type,
          id: tag.dataset.id,
          name: tag.dataset.name,
        })),
      };

      if (!payload.title || !payload.content) {
        showMessage('Report Title and Detailed Briefing are required.', 'error');
        return;
      }

      try {
        const res = await api('/api/codex/echoes/', { method: 'POST', body: JSON.stringify(payload) });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.detail || 'Submission failed');
        }
        showMessage('Report transmitted securely.', 'info');
        handleNavigation('silo'); // Go to "My Reports" list
      } catch (e) {
        showMessage(e.message, 'error');
      }
      break;
    }
    case 'silo-delete-report': {
        const reportId = btn.dataset.id;
        if (!reportId) return;

        openConfirmModal('Confirm Deletion', 'Are you sure you want to permanently delete this report? This action cannot be undone.', async () => {
            try {
                const res = await api(`/api/codex/echoes/${reportId}/`, { method: 'DELETE' });
                if (res.status !== 204) throw new Error('Failed to delete report');
                showMessage('Report permanently deleted.', 'info');
                loadAndRenderSiloLeadershipDashboard('archive'); // Refresh the archive view
            } catch (err) {
                showMessage(err.message, 'error');
            }
        }, 'Delete', 'red');
        break;
    }
  }
});

async function loadAndRenderSiloLeadershipDashboard(view = 'triage') {
    const usp = new URLSearchParams();
    if (view === 'triage') {
        // By default, triage queue shows pending and under review reports.
        usp.set('status__in', 'PENDING,UNDER_REVIEW');
    } else if (view === 'archive') {
        // Archive shows completed reports.
        usp.set('status__in', 'ACTIONED,DISMISSED,PROMOTED');
    }
    const res = await api(`/api/codex/echoes/?${usp.toString()}`);
    if (!res.ok) throw new Error('Failed to load Silo reports');
    const reports = await res.json();
    renderSiloLeadershipDashboard(reports, view);
}

function renderSiloLeadershipDashboard(reports, currentView = 'triage') {
    const area = qs('#abacus-content-area');
    if (!area) return;
    area.className = 'flex-1 p-4 md:p-6 overflow-y-auto transition-colors duration-500 lineage-bg';

    const reportRows = reports.map(r => `
        <tr class="border-t border-gray-800 hover:bg-gold-900/10">
            <td class="px-4 py-2">
                <span class="inline-flex items-center gap-2">
                    ${r.status === 'PENDING' ? '<span class="silo-pulse-dot"></span>' : ''}
                    <span class="inline-block px-2 py-0.5 rounded bg-gray-800 border border-gray-700 text-gray-300 mono">${SILO_STATUS_LABELS[r.status] || r.status}</span>
                </span>
            </td>
            <td class="px-4 py-2 font-medium text-gray-100"><button class="text-left hover:underline" data-action="silo-view-report" data-id="${r.id}">${escapeHtml(r.title)}</button></td>
            <td class="px-4 py-2 text-gray-300">${SILO_CONFIDENCE_LEVELS[r.confidence] || r.confidence}</td>
            <td class="px-4 py-2 text-gray-400 mono">${escapeHtml(r.created_by?.display_name || 'Unknown')}</td>
            <td class="px-4 py-2 text-gray-400 mono">${timeAgo(r.created_at)}</td>
            <td class="px-4 py-2 text-right">
                ${(currentView === 'archive' && ['HQ', 'PROTECTOR'].includes(currentUser.role)) ?
                    `<button class="terminal-btn-outline !text-red-400 !border-red-700/50 hover:!bg-red-900/40 text-xs" data-action="silo-delete-report" data-id="${r.id}">Delete</button>` : ''
                }
            </td>
        </tr>
    `).join('');

    area.innerHTML = `
        <div class="mb-4 flex items-center justify-between gap-3">
            <h2 class="text-xl font-bold lineage-title tracking-widest">THE SILO</h2>
            <div class="flex items-center gap-3">
                <button class="terminal-btn commit" data-action="silo-new-report">» FILE REPORT</button>
            </div>
        </div>
        <div class="silo-tabs mb-4">
            <button class="silo-tab-btn ${currentView === 'triage' ? 'active' : ''}" data-action="silo-view-triage">Triage Queue</button>
            <button class="silo-tab-btn ${currentView === 'archive' ? 'active' : ''}" data-action="silo-view-archive">Archive</button>
        </div>
        <div class="overflow-x-auto panel">
            <table class="min-w-full text-left text-sm">
                <thead class="text-gold-400">
                    <tr>
                        <th class="px-4 py-2">Status</th>
                        <th class="px-4 py-2">Title</th>
                        <th class="px-4 py-2">Confidence</th>
                        <th class="px-4 py-2">Submitted By</th>
                        <th class="px-4 py-2">Date</th>
                        <th class="px-4 py-2"></th>
                    </tr>
                </thead>
                <tbody class="text-gray-200">
                    ${reportRows || `<tr><td colspan="6" class="text-center py-8 text-gray-500 mono">// NO REPORTS IN THIS VIEW</td></tr>`}
                </tbody>
            </table>
        </div>
    `;
}

async function openSiloReportDetail(reportId) {
    try {
        const [reportRes, commentsRes] = await Promise.all([
            api(`/api/codex/echoes/${reportId}/`),
            api(`/api/codex/echoes/${reportId}/comments/`)
        ]);
        if (!reportRes.ok) throw new Error('Failed to load report');
        const report = await reportRes.json();
        const comments = commentsRes.ok ? await commentsRes.json() : [];
        renderSiloReportDetail(report, comments);
    } catch (e) {
        showMessage(e.message, 'error');
        handleNavigation('silo');
    }
}

function renderSiloReportDetail(report, comments) {
    const area = qs('#abacus-content-area');
    if (!area) return;
    area.className = 'flex-1 p-4 md:p-6 overflow-y-auto transition-colors duration-500 lineage-bg';

    const entityTags = (report.involved_entities || []).map(entity => {
        if (!entity || !entity.type || !entity.id || !entity.name) return ''; // Data integrity check

        const isProfile = entity.type === 'profile';
        const action = isProfile ? 'idx-view' : 'scales-view';
        return `<button class="diplo-tag ${isProfile ? 'allied' : 'rival'}" data-action="${action}" data-id="${entity.id}">${isProfile ? '👤' : '⚖️'} ${escapeHtml(entity.name)}</button>`;
    }).join('') || `<span class="text-xs text-gray-500 mono">// NO ENTITIES TAGGED</span>`;

    const evidenceLinks = (report.evidence_urls || '').split(',').map(url => url.trim()).filter(Boolean);
    const evidenceHtml = evidenceLinks.length > 0
        ? `<ul>${evidenceLinks.map((url, i) => `<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="text-emerald-400 hover:underline mono">Evidence File ${i + 1}</a></li>`).join('')}</ul>`
        : `<span class="text-xs text-gray-500 mono">// NO EVIDENCE ATTACHED</span>`;

    const commentHtml = comments.map(c => `
        <div class="silo-comment">
            <div class="silo-comment-meta">
                <span class="font-semibold text-gold-400">${escapeHtml(c.user?.display_name || 'Unknown')}</span>
                <span class="text-gray-500 text-xs mono">${timeAgo(c.created_at)}</span>
            </div>
            <div class="silo-comment-body">${escapeHtml(c.message)}</div>
        </div>
    `).join('') || `<div class="text-xs text-gray-500 mono text-center py-4">// NO COMMENTS</div>`;

    const statusOptions = Object.entries(SILO_STATUS_LABELS)
        .filter(([k, v]) => k !== 'PROMOTED') // Promoted is an action, not a status to set
        .map(([k, v]) => `<option value="${k}" ${k === report.status ? 'selected' : ''}>${v}</option>`).join('');

    const linkedOpsHtml = (report.operation_links && report.operation_links.length > 0)
        ? report.operation_links.map(link => `
            <button class="terminal-btn-outline w-full text-left" data-action="loom-view-op" data-id="${link.operation_id}">${escapeHtml(link.operation_codename)}</button>
        `).join('')
        : `<div class="text-xs text-gray-500 mono">// NO LINKED OPERATIONS</div>`;
    const isLeadership = ['HQ', 'PROTECTOR', 'HEIR'].includes(currentUser.role);

    area.innerHTML = `
        <div class="silo-detail-view" ${!isLeadership ? 'style="grid-template-columns: 1fr;"' : ''}>
            <!-- Left Column: Report Content -->
            <div class="silo-content-panel panel p-4">
                <div class="flex items-start justify-between gap-4 mb-4">
                    <div>
                        <h2 class="text-xl font-bold lineage-title tracking-widest">${escapeHtml(report.title)}</h2>
                        <div class="text-sm text-gray-400 mono mt-1">
                            Submitted by ${escapeHtml(report.created_by?.display_name || 'Unknown')}
                        </div>
                    </div>
                    <button class="terminal-btn abort" data-action="silo-back-to-list">// BACK</button>
                </div>
                <hr class="panel-divider mb-4">
                <div class="space-y-4">
                    <div>
                        <h3 class="panel-title">» Source Confidence</h3>
                        <div class="text-gray-200 mt-1">${SILO_CONFIDENCE_LEVELS[report.confidence] || report.confidence}</div>
                    </div>
                    <div>
                        <h3 class="panel-title">» Involved Entities</h3>
                        <div class="flex flex-wrap gap-2 mt-1">${entityTags}</div>
                    </div>
                    <div>
                        <h3 class="panel-title">» Detailed Briefing</h3>
                        <div class="text-gray-300 whitespace-pre-wrap font-serif mt-1">${multilineContent(report.content)}</div>
                    </div>
                    <div>
                        <h3 class="panel-title">» Attached Evidence</h3>
                        <div class="text-gray-200 mt-1">${evidenceHtml}</div>
                    </div>
                </div>
            </div>

            ${isLeadership ? `
                <!-- Right Column: Action Panel -->
                <div class="silo-action-panel space-y-6">
                    <div class="panel">
                        <h3 class="panel-title p-3 border-b border-gray-800">» Triage & Status</h3>
                        <div class="p-3">
                            <select id="silo-detail-status" data-id="${report.id}" class="terminal-input w-full">
                                ${statusOptions}
                            </select>
                        </div>
                    </div>

                    <div class="panel">
                        <h3 class="panel-title p-3 border-b border-gray-800">» Private Comments 🔒</h3>
                        <div id="silo-comments-list" class="p-3 space-y-3 cy-scroll-slab" style="max-height: 300px;">
                            ${commentHtml}
                        </div>
                        <div class="p-3 border-t border-gray-800">
                            <textarea id="silo-new-comment" class="terminal-input w-full" rows="3" placeholder="Add a private comment..."></textarea>
                            <div class="text-right mt-2">
                                <button class="terminal-btn-outline text-sm" data-action="silo-add-comment" data-id="${report.id}">Add Comment</button>
                            </div>
                        </div>
                    </div>

                    <div class="panel">
                        <h3 class="panel-title p-3 border-b border-gray-800">» Linked Operations</h3>
                        <div class="p-3">
                            <div id="linked-operations-list" class="space-y-2">${linkedOpsHtml}</div>
                        </div>
                    </div>

                    <div class="panel">
                        <h3 class="panel-title p-3 border-b border-gray-800">» Quick Actions</h3>
                        <div class="p-3 space-y-2">
                            <button class="terminal-btn-outline w-full text-left" data-action="silo-attach-to-op" data-id="${report.id}">» Attach to Operation...</button>
                            <button class="terminal-btn-outline w-full text-left" data-action="silo-create-task" data-id="${report.id}" disabled>+ Create Task</button>
                            <button class="terminal-btn-outline w-full text-left" data-action="silo-launch-op" data-id="${report.id}">» Launch Operation...</button>
                        </div>
                    </div>
                </div>` : ''}
        </div>
    `;

    if (isLeadership) {
        qs('#silo-detail-status').addEventListener('change', async (e) => {
            const reportId = e.target.dataset.id;
            const newStatus = e.target.value;
            try {
                const res = await api(`/api/codex/echoes/${reportId}/set-status/`, {
                    method: 'POST',
                    body: JSON.stringify({ status: newStatus })
                });
                if (!res.ok) throw new Error('Failed to update status');
                showMessage('Report status updated.', 'info');
            } catch (err) {
                showMessage(err.message, 'error');
                e.target.value = report.status; // Revert on failure
            }
        });
    }
}

// Centralized event handler for the Scales module
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action^="scales-"]');
  if (!btn) return;

  const action = btn.getAttribute('data-action');
  const id = btn.getAttribute('data-id');

  switch (action) { 
    case 'scales-view':
      if (id) openFactionDetail(id);
      break;
    case 'scales-back':
      try {
        const data = await loadFactions();
        renderFactionsList(data);
      } catch (err) {
        showMessage(err.message || 'Failed to load Factions', 'error');
      }
      break;
    case 'scales-edit':
      if (id) {
        const res = await api(`/api/scales/factions/${id}/`);
        if (!res.ok) { showMessage(`Load failed (${res.status})`, 'error'); return; }
        const item = await res.json();
        renderFactionDetailEdit(item);
      }
      break;
    case 'scales-manage-members': {
      const id = btn.getAttribute('data-id');
      const name = btn.getAttribute('data-name');
      if (id) {
        openManageMembersModal(id, name);
      }
      break;
    }
    case 'scales-del':
      if (id) {
        const factionName = btn.closest('.faction-profile')?.querySelector('#fa-name')?.textContent || 'this faction';
        openConfirmModal('Confirm Deletion', `Are you sure you want to delete ${factionName}? This action cannot be undone.`, async () => {
          const res = await api(`/api/scales/factions/${id}/`, { method: 'DELETE' });
          if (res.status === 204 || res.ok) {
            showMessage('Faction deleted.', 'info');
            const data = await loadFactions();
            renderFactionsList(data);
          } else {
            showMessage(`Delete failed (${res.status})`, 'error');
          }
        }, 'Delete', 'red');
      } 
      break;
    // scales-inline-save is handled in its own listener
  }
});

// ===== The Loom UI (Operations) =====

async function loadAndRenderLoomDashboard() {
    const isLeadership = ['HQ', 'PROTECTOR', 'HEIR'].includes(currentUser.role);
    if (!isLeadership) {
        handleNavigation('dashboard'); // Or show a permission denied message
        return;
    }
    try {
        const res = await api('/api/loom/operations/');
        if (!res.ok) throw new Error('Failed to load operations');
        const operations = await res.json();
        renderLoomDashboard(operations);
    } catch (e) {
        showMessage(e.message, 'error');
    }
}

function getOpStatusClass(status) {
    const s = (status || '').toUpperCase();
    if (s.includes('PLANNING')) return 'status-planning';
    if (s.includes('ACTIVE')) return 'status-active';
    if (s.includes('SUCCESS')) return 'status-success';
    if (s.includes('FAILURE') || s.includes('COMPROMISED')) return 'status-failure';
    if (s.includes('LOW')) return 'status-planning'; // Re-use for low risk
    if (s.includes('MEDIUM')) return 'status-active'; // Re-use for medium risk
    if (s.includes('HIGH')) return 'status-high';
    if (s.includes('CRITICAL')) return 'status-critical';
    return 'status-unknown';
}

function renderLoomDashboard(operations) {
    const area = qs('#abacus-content-area');
    if (!area) return;
    area.className = 'flex-1 p-4 md:p-6 overflow-y-auto transition-colors duration-500 lineage-bg';

    const planningOps = operations.filter(op => op.status === 'PLANNING');
    const activeOps = operations.filter(op => op.status === 'ACTIVE');
    const concludedOps = operations.filter(op => op.status.startsWith('CONCLUDED') || op.status === 'COMPROMISED');

    const renderOpCard = (op) => `
        <div class="loom-op-card" data-action="loom-view-op" data-id="${op.id}">
            <div class="loom-op-card-header">
                <h4 class="loom-op-card-title">${escapeHtml(op.codename)}</h4>
                <span class="op-status-badge ${getOpStatusClass(op.status)}">${escapeHtml(op.status)}</span>
            </div>
            <div class="loom-op-card-body">
                <div class="loom-op-card-meta">Targets: <span>${op.targets?.length || 0}</span></div>
                <div class="loom-op-card-meta">Personnel: <span>${op.personnel?.length || 0}</span></div>
            </div>
        </div>
    `;

    area.innerHTML = `
        <div class="mb-4 flex items-center justify-between gap-3">
            <h2 class="text-xl font-bold lineage-title tracking-widest">THE LOOM // OPERATIONS</h2>
            <button class="terminal-btn commit" data-action="loom-new-op">» New Operation</button>
        </div>
        <div class="loom-dashboard-columns">
            <div class="loom-column">
                <h3 class="loom-column-title">» PLANNING</h3>
                <div class="loom-card-list cy-scroll-slab">
                    ${planningOps.length ? planningOps.map(renderOpCard).join('') : '<div class="loom-card-empty">// NO OPERATIONS IN PLANNING</div>'}
                </div>
            </div>
            <div class="loom-column">
                <h3 class="loom-column-title">» ACTIVE</h3>
                <div class="loom-card-list cy-scroll-slab">
                    ${activeOps.length ? activeOps.map(renderOpCard).join('') : '<div class="loom-card-empty">// NO ACTIVE OPERATIONS</div>'}
                </div>
            </div>
            <div class="loom-column">
                <h3 class="loom-column-title">» CONCLUDED</h3>
                <div class="loom-card-list cy-scroll-slab">
                    ${concludedOps.length ? concludedOps.map(renderOpCard).join('') : '<div class="loom-card-empty">// NO CONCLUDED OPERATIONS</div>'}
                </div>
            </div>
        </div>
    `;
}

function openLaunchOperationModal(prefill = {}) {
    const html = `
        <div class="cy-panel rounded-lg overflow-hidden" style="min-width: 720px;">
            <div class="modal-title py-3 border-b border-gray-800 bg-gray-950/70">
                <div class="text-lg font-semibold text-gray-100 tracking-wide mono px-4">» LAUNCH OPERATION</div>
            </div>
            <div class="modal-body p-4 bg-gray-950/40 space-y-4">
                <div>
                    <label class="form-label-gold">» Operation Codename</label>
                    <input id="op_codename" class="form-input-gold w-full" value="${escapeHtml(prefill.codename || '')}" placeholder="e.g., Operation Night Owl">
                </div>
                <div>
                    <label class="form-label-gold">» Primary Objectives</label>
                    <textarea id="op_objective" class="form-input-gold w-full h-32 cy-scroll-slab" placeholder="Detail the primary goals of this operation...">${escapeHtml(prefill.objectives || '')}</textarea>
                </div>
                <div>
                    <label class="form-label-gold">» Initial Risk Assessment</label>
                    <select id="op_risk" class="form-input-gold w-full">
                        <option value="LOW">Low</option>
                        <option value="MEDIUM" selected>Medium</option>
                        <option value="HIGH">High</option>
                        <option value="CRITICAL">Critical</option>
                    </select>
                </div>
            </div>
            <footer class="py-3 border-t border-gray-800 bg-gray-950/70 flex justify-end gap-3 px-4">
                <button data-action="close-modal" class="terminal-btn abort">// CANCEL</button>
                <button id="op-launch-btn" class="terminal-btn commit">// LAUNCH</button>
            </footer>
        </div>
    `;
    openModal(html);

    qs('#op-launch-btn').addEventListener('click', async () => {
        const payload = {
            codename: qs('#op_codename').value.trim(),
            objective: qs('#op_objective').value.trim(),
            collateral_risk: qs('#op_risk').value,
        };

        if (!payload.codename || !payload.objective) {
            showMessage('Codename and Objectives are required.', 'error');
            return;
        }

        try {
            const res = await api('/api/loom/operations/', { method: 'POST', body: JSON.stringify(payload) });
            if (!res.ok) throw new Error('Failed to launch operation.');
            showMessage('Operation successfully planned.', 'info');
            closeModal();
            loadAndRenderLoomDashboard();
        } catch (e) {
            showMessage(e.message, 'error');
        }
    });
}

document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action^="loom-"]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    if (action === 'loom-new-op') {
        openLaunchOperationModal();
    } else if (action === 'loom-view-op') {
        await openLoomOperationDetail(btn.dataset.id);
    } else if (action === 'loom-back') {
        loadAndRenderLoomDashboard();
    } else if (action === 'loom-edit') {
        openLoomOperationEdit(btn.dataset.id);
    } else if (action === 'loom-abort') {
        openLoomOperationDetail(btn.dataset.id);
    } else if (action === 'loom-save') {
        saveOperation(btn.dataset.id);
    } else if (action === 'loom-add-log') { // Add log entry
        const opId = btn.dataset.id;
        const textarea = qs('#loom-new-log-entry');
        const message = textarea.value.trim();
        if (!opId || !textarea || !message) return;

        try {
            const res = await api(`/api/loom/operations/${opId}/logs/`, {
                method: 'POST',
                body: JSON.stringify({ message })
            });
            if (!res.ok) throw new Error('Failed to add log entry.');
            showMessage('Log entry added.', 'info');
            await openLoomOperationDetail(opId); // Refresh the view
        } catch (err) {
            showMessage(err.message, 'error');
        }
    } else if (action === 'loom-manage-personnel') {
        openManagePersonnelModal(btn.dataset.id);
    } else if (action === 'loom-manage-targets') {
        openManageTargetsModal(btn.dataset.id);
    } else if (action === 'loom-attach-intel') {
        openAttachIntelModal(btn.dataset.id);
    } else if (action === 'loom-detach-intel') {
        const linkId = btn.dataset.linkId;
        const opId = btn.closest('.loom-op-view').dataset.opId;
        if (!linkId || !opId) return;

        openConfirmModal('Confirm Detach', 'Are you sure you want to detach this report?', async () => {
            try {
                const res = await api(`/api/loom/report-links/${linkId}/`, { method: 'DELETE' });
                if (res.status !== 204 && !res.ok) throw new Error('Failed to detach report.');
                showMessage('Report detached.', 'info');
                openLoomOperationDetail(opId); // Refresh the view
            } catch (err) {
                showMessage(err.message, 'error');
            }
        }, 'Detach', 'red');
    }
});

const renderOpPersonnel = (personnel) => (personnel && personnel.length)
    ? personnel.map(({ agent, role_in_op }) => `
        <div class="roster-list-entry flex items-center justify-between gap-3 border border-gray-800/60 bg-gray-950/60 hover:border-emerald-500/50 rounded px-3 py-2 transition">
            <button class="text-left flex-1 min-w-0 text-gray-100 hover:text-emerald-400 focus:text-emerald-400 truncate mono" data-action="lineage-view-dossier" data-id="${agent.id}">
                ${escapeHtml(agent.alias)}
            </button>
            <span class="text-xs text-gray-400 mono">${escapeHtml(role_in_op)}</span>
        </div>`).join('')
    : `<div class="text-gray-600 text-xs mono text-center py-6">// NO PERSONNEL ASSIGNED</div>`;

const renderOpTargets = (factionTargets = [], profileTargets = []) => {
    const factions = factionTargets.map(target => `
        <div class="roster-list-entry flex items-center justify-between gap-3 border border-gray-800/60 bg-gray-950/60 hover:border-emerald-500/50 rounded px-3 py-2 transition">
            <button class="text-left flex-1 min-w-0 text-gray-100 hover:text-emerald-400 focus:text-emerald-400 truncate mono" data-action="scales-view" data-id="${target.id}">
                ⚖️ ${escapeHtml(target.name)}
            </button>
        </div>`).join('');
    const profiles = profileTargets.map(target => `
        <div class="roster-list-entry flex items-center justify-between gap-3 border border-gray-800/60 bg-gray-950/60 hover:border-emerald-500/50 rounded px-3 py-2 transition">
            <button class="text-left flex-1 min-w-0 text-gray-100 hover:text-emerald-400 focus:text-emerald-400 truncate mono" data-action="idx-view" data-id="${target.id}">
                👤 ${escapeHtml(target.full_name)}
            </button>
        </div>`).join('');

    const allTargets = factions + profiles;
    return allTargets || `<div class="text-gray-600 text-xs mono text-center py-6">// NO TARGETS DESIGNATED</div>`;
};

async function openLoomOperationDetail(operationId) {
    try {
        const res = await api(`/api/loom/operations/${operationId}/`);
        if (!res.ok) throw new Error('Failed to load operation details.');
        const operation = await res.json();
        renderLoomOperationDetail(operation);
    } catch (e) {
        showMessage(e.message, 'error');
    }
}

async function openLoomOperationEdit(operationId) {
    try {
        const res = await api(`/api/loom/operations/${operationId}/`);
        if (!res.ok) throw new Error('Failed to load operation details for editing.');
        const operation = await res.json();
        renderLoomOperationEdit(operation);
    } catch (e) {
        showMessage(e.message, 'error');
    }
}

function renderLoomOperationEdit(op) {
    const area = qs('#abacus-content-area');
    if (!area) return;
    area.className = 'flex-1 p-4 md:p-6 overflow-y-auto transition-colors duration-500 lineage-bg';

    const OP_STATUS_OPTIONS = {
        'PLANNING': 'Planning',
        'ACTIVE': 'Active',
        'CONCLUDED - SUCCESS': 'Success',
        'CONCLUDED - FAILURE': 'Failure',
        'COMPROMISED': 'Compromised'
    };
    const RISK_LEVELS = {
        'LOW': 'Low',
        'MEDIUM': 'Medium',
        'HIGH': 'High',
        'CRITICAL': 'Critical'
    };

    const statusSelect = renderCustomSelect('op_status', OP_STATUS_OPTIONS, op.status);
    const riskSelect = renderCustomSelect('op_risk', RISK_LEVELS, op.collateral_risk);

    area.innerHTML = `
        <div class="space-y-6 loom-op-view lineage-dossier edit-mode" data-op-id="${op.id}">
            <div class="flex flex-wrap items-start justify-between gap-3 cypher-header pb-4">
                <div class="flex-1 space-y-2">
                    <h2 class="text-xl font-bold lineage-title tracking-widest truncate">
                        <span class="text-white">OPERATION: ${escapeHtml(op.codename)}</span>
                    </h2>
                    <div class="flex items-center gap-4">
                        <div class="w-48">${statusSelect}</div>
                        <div class="w-48">${riskSelect}</div>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <button class="terminal-btn commit" data-action="loom-save" data-id="${op.id}">// COMMIT</button>
                    <button class="terminal-btn abort" data-action="loom-abort" data-id="${op.id}">// ABORT</button>
                </div>
            </div>
            <hr class="page-divider mb-6">

            <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
                <div class="space-y-4">
                    <div>
                        <h3 class="panel-title">» Objective / Plan</h3>
                        <hr class="panel-divider my-2">
                        <textarea id="op_objective" class="terminal-input w-full h-96 cy-scroll-slab font-serif" placeholder="// Detail the plan, objectives, and contingencies...">${escapeHtml(op.objective || '')}</textarea>
                    </div>
                </div>
                <div class="space-y-4">
                    <div>
                        <h3 class="panel-title">» Assigned Personnel</h3>
                        <hr class="panel-divider my-2">
                        <div id="op-personnel-list" class="roster-list cy-scroll-slab space-y-2" style="max-height: 240px;">
                            ${renderOpPersonnel(op.personnel)}
                        </div>
                        <button class="terminal-btn-outline text-xs mt-2" data-action="loom-manage-personnel" data-id="${op.id}">» Manage Personnel</button>
                    </div>
                    <div>
                        <h3 class="panel-title">» Designated Targets</h3>
                        <hr class="panel-divider my-2">
                        <div id="op-targets-list" class="roster-list cy-scroll-slab space-y-2" style="max-height: 240px;">
                            ${renderOpTargets(op.targets)}
                        </div>
                        <button class="terminal-btn-outline text-xs mt-2" data-action="loom-manage-targets" data-id="${op.id}">Manage Targets</button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

async function saveOperation(operationId) {
    const payload = {
        objective: qs('#op_objective')?.value.trim(),
        status: qs('#op_status')?.value,
        collateral_risk: qs('#op_risk')?.value,
    };

    try {
        const res = await api(`/api/loom/operations/${operationId}/`, { method: 'PATCH', body: JSON.stringify(payload) });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || 'Failed to save operation.');
        }
        showMessage('Operation plan updated.', 'info');
        openLoomOperationDetail(operationId); // Go back to view mode
    } catch (e) {
        showMessage(e.message, 'error');
    }
}

async function openAttachIntelModal(operationId) {
    const html = `
        <div class="cy-panel rounded-lg overflow-hidden" style="min-width: 640px;">
            <div class="modal-title py-3 border-b border-gray-800 bg-gray-950/70">
                <div class="text-lg font-semibold text-gray-100 tracking-wide mono px-4">» ATTACH INTEL REPORT</div>
            </div>
            <div class="modal-body p-4 bg-gray-950/40 space-y-3">
                <input id="attach-intel-search" class="terminal-input w-full" placeholder="Search Silo reports..." autocomplete="off">
                <div id="attach-intel-results" class="cy-scroll-slab h-64 overflow-y-auto border border-gray-800 rounded bg-gray-900/50"></div>
            </div>
        </div>`;
    openModal(html);

    const searchInput = qs('#attach-intel-search');
    const resultsContainer = qs('#attach-intel-results');
    let searchTimer = null;

    const loadReports = async (query = '') => {
        try {
            const res = await api(`/api/codex/echoes/?q=${encodeURIComponent(query)}`);
            if (!res.ok) throw new Error('Failed to load reports.');
            const reports = await res.json();

            if (!reports.length) {
                resultsContainer.innerHTML = `<div class="text-center text-gray-500 mono text-xs py-8">// NO MATCHING REPORTS FOUND</div>`;
                return;
            }

            resultsContainer.innerHTML = reports.map(report => `
                <button class="induct-result-item" data-action="attach-intel-select" data-report-id="${report.id}">
                    <span class="font-semibold text-emerald-400">${escapeHtml(report.title)}</span>
                    <span class="text-gray-400 text-xs">(${escapeHtml(report.status)})</span>
                </button>
            `).join('');
        } catch (e) {
            resultsContainer.innerHTML = `<div class="text-center text-red-500 mono text-xs py-8">// FAILED TO LOAD REPORTS</div>`;
        }
    };

    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            const query = searchInput.value.trim();
            if (query.length < 2) {
                resultsContainer.innerHTML = '';
                return;
            }
            loadReports(query);
        }, 300);
    });

    resultsContainer.addEventListener('click', async (e) => {
        const target = e.target.closest('[data-action="attach-intel-select"]');
        if (!target) return;

        const reportId = target.getAttribute('data-report-id');

        try {
            const res = await api(`/api/loom/report-links/`, {
                method: 'POST',
                body: JSON.stringify({ operation: operationId, report: reportId })
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || 'Failed to attach report.');
            }

            showMessage('Report attached to operation.', 'info');
            closeModal();
            openLoomOperationDetail(operationId);
        } catch (err) {
            showMessage(err.message, 'error');
        }
    });

    loadReports('');
}

async function openAttachToOperationModal(reportId) {
    if (!reportId) return;

    const html = `
    <div class="cy-panel rounded-lg overflow-hidden" style="min-width: 640px;">
      <div class="modal-title py-3 border-b border-gray-800 bg-gray-950/70">
        <div class="text-lg font-semibold text-gray-100 tracking-wide mono px-4">» ATTACH REPORT TO OPERATION</div>
      </div>
      <div class="modal-body p-4 bg-gray-950/40 space-y-3">
        <input id="attach-op-search" class="terminal-input w-full" placeholder="Search active operations..." autocomplete="off">
        <div id="attach-op-error" class="text-red-400 mono text-sm hidden"></div>
        <div id="attach-op-results" class="cy-scroll-slab h-64 overflow-y-auto border border-gray-800 rounded bg-gray-900/50">
          <div class="cy-spinner"></div>
        </div>
      </div>
      <footer class="py-3 border-t border-gray-800 bg-gray-950/70 flex justify-end gap-3 px-4">
        <button data-action="close-modal" class="terminal-btn abort">// CANCEL</button>
      </footer>
    </div>
  `;
    openModal(html);

    const searchInput = qs('#attach-op-search');
    const resultsContainer = qs('#attach-op-results');
    const errorContainer = qs('#attach-op-error');
    let searchTimer = null;

    const loadOperations = async (query = '') => {
        try {
            const res = await api(`/api/loom/operations/?status__in=PLANNING,ACTIVE&q=${encodeURIComponent(query)}`);
            if (!res.ok) throw new Error('Failed to load operations.');
            const operations = await res.json();

            if (!operations.length) {
                resultsContainer.innerHTML = `<div class="text-center text-gray-500 mono text-xs py-8">// NO MATCHING OPERATIONS FOUND</div>`;
                return;
            }

            resultsContainer.innerHTML = operations.map(op => `
                <button class="induct-result-item" data-action="attach-op-select" data-op-id="${op.id}">
                    <span class="font-semibold text-emerald-400">${escapeHtml(op.codename)}</span>
                    <span class="text-gray-400 text-xs">(${escapeHtml(op.status)})</span>
                </button>
            `).join('');
        } catch (e) {
            resultsContainer.innerHTML = `<div class="text-center text-red-500 mono text-xs py-8">// FAILED TO LOAD OPERATIONS</div>`;
        }
    };

    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            loadOperations(searchInput.value.trim());
        }, 300);
    });

    resultsContainer.addEventListener('click', async (e) => {
        const target = e.target.closest('[data-action="attach-op-select"]');
        if (!target) return;

        const operationId = target.getAttribute('data-op-id');
        hide(errorContainer);

        try {
            const res = await api(`/api/loom/report-links/`, {
                method: 'POST',
                body: JSON.stringify({ operation: operationId, report: reportId })
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || 'Failed to attach report.');
            }

            showMessage('Report attached to operation.', 'info');
            closeModal();
            // Optionally, refresh the silo report detail view to show the new link
            openSiloReportDetail(reportId);
        } catch (err) {
            errorContainer.textContent = `// ERROR: ${err.message}`;
            show(errorContainer);
        }
    });

    loadOperations(); // Initial load
}


function renderLoomOperationDetail(op) {
    const area = qs('#abacus-content-area');
    if (!area) return
    area.className = 'flex-1 p-4 md:p-6 overflow-y-auto transition-colors duration-500 lineage-bg';

    const logsHtml = (op.logs && op.logs.length)
        ? op.logs.map(log => `
            <div class="history-item">
                <div class="history-meta mono">${escapeHtml(log.user_display_name || 'System')} | ${formatTimestamp(log.timestamp)}</div>
                <div class="history-text text-sm text-gray-300">${escapeHtml(log.message)}</div>
            </div>`).join('')
        : `<div class="text-gray-500 text-xs mono text-center py-6">// NO LOG ENTRIES</div>`;

    const intelHtml = (op.report_links && op.report_links.length)
        ? op.report_links.map(link => `
            <div class="history-item">
                <button class="text-left hover:underline" data-action="silo-view-report" data-id="${link.report_id}">${escapeHtml(link.report_title)}</button>
                <div class="text-xs text-gray-400 mono">Linked by ${escapeHtml(link.linked_by_username)} | ${timeAgo(link.linked_at)}</div>
            </div>`).join('')
        : `<div class="text-gray-500 text-xs mono text-center py-6">// NO INTEL LINKED</div>`;

    area.innerHTML = `
        <div class="space-y-6 loom-op-view lineage-dossier">
            <div class="flex flex-wrap items-start justify-between gap-3 cypher-header pb-4">
                <div class="flex-1 space-y-2">
                    <h2 class="text-xl font-bold lineage-title tracking-widest truncate">
                        <button data-action="loom-back" class="breadcrumb-link">THE LOOM</button>
                        <span class="breadcrumb-sep">/</span>
                        <span class="text-white">OPERATION: ${escapeHtml(op.codename)}</span>
                    </h2>
                    <div class="flex items-center gap-2">
                        <span class="op-status-badge ${getOpStatusClass(op.status)}">${escapeHtml(op.status)}</span>
                        <span class="op-status-badge ${getOpStatusClass(op.collateral_risk)}">RISK: ${escapeHtml(op.collateral_risk || 'UNKNOWN')}</span>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <button class="terminal-btn-outline" data-action="loom-edit" data-id="${op.id}">EDIT</button>
                    <button class="terminal-btn-outline" data-action="loom-back">// BACK</button>
                </div>
            </div>
            <hr class="page-divider mb-6">

            <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
                <div class="space-y-4">
                    <div>
                        <h3 class="panel-title">» Objective / Plan</h3>
                        <hr class="panel-divider my-2">
                        <div class="text-sm text-gray-300 font-serif">${multilineContent(op.objective, '// NO OBJECTIVES DEFINED')}</div>
                    </div>
                    <div>
                        <h3 class="panel-title">» Assigned Personnel</h3>
                        <hr class="panel-divider my-2">
                        <div class="roster-list cy-scroll-slab space-y-2" style="max-height: 240px;">${renderOpPersonnel(op.personnel)}</div>
                    </div>
                    <div>
                        <h3 class="panel-title">» Designated Targets</h3>
                        <hr class="panel-divider my-2">
                        <div class="roster-list cy-scroll-slab space-y-2" style="max-height: 240px;">${renderOpTargets(op.targets, op.individual_targets)}</div>
                    </div>
                </div>
                <div class="space-y-4">
                    <div>
                        <h3 class="panel-title">» Operations Log</h3>
                        <hr class="panel-divider my-2">
                        <div class="history-feed cy-scroll-slab" style="height: 480px;">${logsHtml}</div>
                        <div class="mt-2">
                            <textarea id="loom-new-log-entry" class="terminal-input w-full" rows="2" placeholder="${op.status === 'ACTIVE' ? 'Add new log entry...' : 'Logging is available for ACTIVE operations.'}" ${op.status !== 'ACTIVE' ? 'disabled' : ''}></textarea>
                            <button class="terminal-btn-outline text-xs mt-2" data-action="loom-add-log" data-id="${op.id}" ${op.status !== 'ACTIVE' ? 'disabled' : ''}>Add Entry</button>
                        </div>
                    </div>
                    <div>
                        <h3 class="panel-title">» Linked Intelligence</h3>
                        <hr class="panel-divider my-2">
                        <div class="history-feed cy-scroll-slab" style="height: 240px;">${intelHtml}</div>
                        <button class="terminal-btn-outline text-xs mt-2" data-action="loom-attach-intel" data-id="${op.id}">» Attach Intel...</button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function openManagePersonnelModal(operationId) {
    const html = `
    <div class="manage-roster-modal cy-panel rounded-lg overflow-hidden" style="min-width: 960px;">
      <div class="modal-title py-4 border-b border-gray-800 flex items-center justify-between bg-gray-950/70 px-4">
        <div class="text-lg font-semibold text-gray-100 tracking-wide mono">» MANAGE PERSONNEL</div>
      </div>
      <div class="modal-body grid grid-cols-1 lg:grid-cols-2 gap-4 py-4 px-4 bg-gray-950/40">
        <section class="roster-column flex flex-col gap-3">
          <header class="flex items-center justify-between">
            <div class="text-sm text-gray-300 tracking-wide mono">» ASSIGNED PERSONNEL</div>
            <div class="text-xs text-gray-500 mono">// <span id="op-member-count">0</span> ASSIGNED</div>
          </header>
          <div id="op-assigned-list" class="roster-manage-list cy-scroll-slab bg-gray-900/40 border border-gray-800 rounded p-3 space-y-2 overflow-y-auto" style="max-height: 420px;"></div>
        </section>
        <section class="roster-column flex flex-col gap-3">
          <header class="flex flex-col gap-2">
            <div class="text-sm text-gray-300 tracking-wide mono">» ADD AGENT FROM LINEAGE</div>
            <input id="op-personnel-search" class="w-full px-3 py-2 rounded bg-gray-950 border border-gray-800 text-gray-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/60 mono placeholder:text-gray-500" placeholder="Search The Lineage…" autocomplete="off">
          </header>
          <div id="op-candidates-list" class="roster-manage-list cy-scroll-slab bg-gray-900/40 border border-gray-800 rounded p-3 space-y-2 text-sm text-gray-400 overflow-y-auto mono" style="max-height: 420px;">Start typing to search...</div>
        </section>
      </div>
      <footer class="py-4 border-t border-gray-800 bg-gray-950/70 flex justify-end gap-3 px-4">
        <button data-action="close-modal" class="terminal-btn abort">// CANCEL</button> 
        <button id="op-personnel-save" class="terminal-btn commit">// COMMIT ROSTER</button>
      </footer>
    </div>`;
    openModal(html);

    const state = {
        assigned: new Map(), // agent_id -> { agent_id, alias, role_in_op }
        candidates: [],
        searchTimer: null,
    };

    const assignedListEl = qs('#op-assigned-list');
    const candidatesListEl = qs('#op-candidates-list');
    const searchInputEl = qs('#op-personnel-search');
    const saveBtnEl = qs('#op-personnel-save');
    const countEl = qs('#op-member-count');

    const renderAssigned = () => {
        const assigned = Array.from(state.assigned.values()).sort((a, b) => a.alias.localeCompare(b.alias));
        countEl.textContent = assigned.length;
        if (!assigned.length) {
            assignedListEl.innerHTML = '<div class="text-gray-600 text-xs mono tracking-wide text-center py-6">// NO PERSONNEL ASSIGNED</div>';
            return;
        }
        assignedListEl.innerHTML = assigned.map(entry => `
            <div class="roster-manage-item flex items-center gap-3 bg-gray-950/70 border border-gray-800/80 rounded px-3 py-2" data-id="${entry.agent_id}">
                <div class="flex-1 min-w-0">
                    <div class="roster-manage-name text-sm text-gray-100 truncate mono">${escapeHtml(entry.alias)}</div>
                </div>
                <div class="roster-manage-controls flex items-center gap-2">
                    <input class="roster-manage-select bg-gray-950 border border-gray-800 text-gray-100 text-xs px-2 py-1 rounded mono focus:ring-emerald-500/50" value="${escapeHtml(entry.role_in_op)}" placeholder="Role in Op..." data-role="role-input" data-id="${entry.agent_id}">
                    <button class="roster-remove-btn text-rose-400 hover:text-rose-300 text-sm px-2" data-role="remove-agent" data-id="${entry.agent_id}" aria-label="Remove">✕</button>
                </div>
            </div>`).join('');
    };

    const renderCandidates = () => {
        if (!state.candidates.length) {
            candidatesListEl.innerHTML = '<div class="text-gray-600 text-xs mono tracking-wide text-center py-6">// NO MATCHING AGENTS</div>';
            return;
        }
        candidatesListEl.innerHTML = state.candidates.map(cand => `
            <button class="roster-candidate flex items-start justify-between gap-3 bg-gray-950/60 border border-gray-800/80 rounded px-3 py-2 transition hover:border-emerald-500/50 w-full text-left" data-role="add-agent" data-id="${cand.id}" data-alias="${escapeHtml(cand.alias)}">
                <div class="text-sm text-gray-100 mono truncate">${escapeHtml(cand.alias)}</div>
                <div class="text-[10px] text-gray-500 uppercase mono tracking-wide">AGENT #${cand.id}</div>
            </button>`).join('');
    };

    const loadData = async (query = '') => {
        const res = await api(`/api/loom/operations/${operationId}/manage-personnel/?q=${encodeURIComponent(query)}`);
        if (!res.ok) { showMessage('Failed to load personnel data.', 'error'); return; }
        const data = await res.json();
        
        if (!query) { // Initial load
            state.assigned.clear();
            data.assigned.forEach(a => state.assigned.set(a.agent_id, a));
            renderAssigned();
        }
        state.candidates = data.candidates || [];
        renderCandidates();
    };

    searchInputEl.addEventListener('input', () => {
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(() => {
            const query = searchInputEl.value.trim();
            if (query.length < 2) {
                candidatesListEl.innerHTML = 'Start typing to search...';
                return;
            }
            loadData(query);
        }, 300);
    });

    assignedListEl.addEventListener('input', (e) => {
        const input = e.target.closest('[data-role="role-input"]');
        if (!input) return;
        const agentId = Number(input.dataset.id);
        if (state.assigned.has(agentId)) {
            state.assigned.get(agentId).role_in_op = input.value;
        }
    });

    assignedListEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-role="remove-agent"]');
        if (!btn) return;
        const agentId = Number(btn.dataset.id);
        state.assigned.delete(agentId);
        renderAssigned();
    });

    candidatesListEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-role="add-agent"]');
        if (!btn) return;
        const agentId = Number(btn.dataset.id);
        const alias = btn.dataset.alias;
        if (!state.assigned.has(agentId)) {
            state.assigned.set(agentId, { agent_id: agentId, alias, role_in_op: 'Field Agent' });
            renderAssigned();
            // Remove from candidates to prevent re-adding
            state.candidates = state.candidates.filter(c => c.id !== agentId);
            renderCandidates();
        }
    });

    saveBtnEl.addEventListener('click', async () => {
        const payload = { assignments: Array.from(state.assigned.values()) };
        try {
            const res = await api(`/api/loom/operations/${operationId}/manage-personnel/`, { method: 'POST', body: JSON.stringify(payload) });
            if (!res.ok) throw new Error('Failed to update personnel.');
            showMessage('Personnel roster updated.', 'info');
            closeModal();
            openLoomOperationDetail(operationId); // Refresh the main view
        } catch (e) {
            showMessage(e.message, 'error');
        }
    });

    loadData(); // Initial load
}
function openManagePersonnelModal(operationId) {
    const html = `
    <div class="manage-roster-modal cy-panel rounded-lg overflow-hidden" style="min-width: 960px;">
      <div class="modal-title py-4 border-b border-gray-800 flex items-center justify-between bg-gray-950/70 px-4">
        <div class="text-lg font-semibold text-gray-100 tracking-wide mono">» MANAGE PERSONNEL</div>
      </div>
      <div class="modal-body grid grid-cols-1 lg:grid-cols-2 gap-4 py-4 px-4 bg-gray-950/40">
        <section class="roster-column flex flex-col gap-3">
          <header class="flex items-center justify-between">
            <div class="text-sm text-gray-300 tracking-wide mono">» ASSIGNED PERSONNEL</div>
            <div class="text-xs text-gray-500 mono">// <span id="op-member-count">0</span> ASSIGNED</div>
          </header>
          <div id="op-assigned-list" class="roster-manage-list cy-scroll-slab bg-gray-900/40 border border-gray-800 rounded p-3 space-y-2 overflow-y-auto" style="max-height: 420px;"></div>
        </section>
        <section class="roster-column flex flex-col gap-3">
          <header class="flex flex-col gap-2">
            <div class="text-sm text-gray-300 tracking-wide mono">» ADD AGENT FROM LINEAGE</div>
            <input id="op-personnel-search" class="w-full px-3 py-2 rounded bg-gray-950 border border-gray-800 text-gray-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/60 mono placeholder:text-gray-500" placeholder="Search The Lineage…" autocomplete="off">
          </header>
          <div id="op-candidates-list" class="roster-manage-list cy-scroll-slab bg-gray-900/40 border border-gray-800 rounded p-3 space-y-2 text-sm text-gray-400 overflow-y-auto mono" style="max-height: 420px;">Start typing to search...</div>
        </section>
      </div>
      <footer class="py-4 border-t border-gray-800 bg-gray-950/70 flex justify-end gap-3 px-4">
        <button data-action="close-modal" class="terminal-btn abort">// CANCEL</button> 
        <button id="op-personnel-save" class="terminal-btn commit">// COMMIT ROSTER</button>
      </footer>
    </div>`;
    openModal(html);

    const state = {
        assigned: new Map(), // agent_id -> { agent_id, alias, role_in_op }
        candidates: [],
        searchTimer: null,
    };

    const assignedListEl = qs('#op-assigned-list');
    const candidatesListEl = qs('#op-candidates-list');
    const searchInputEl = qs('#op-personnel-search');
    const saveBtnEl = qs('#op-personnel-save');
    const countEl = qs('#op-member-count');

    const renderAssigned = () => {
        const assigned = Array.from(state.assigned.values()).sort((a, b) => a.alias.localeCompare(b.alias));
        countEl.textContent = assigned.length;
        if (!assigned.length) {
            assignedListEl.innerHTML = '<div class="text-gray-600 text-xs mono tracking-wide text-center py-6">// NO PERSONNEL ASSIGNED</div>';
            return;
        }
        assignedListEl.innerHTML = assigned.map(entry => `
            <div class="roster-manage-item flex items-center gap-3 bg-gray-950/70 border border-gray-800/80 rounded px-3 py-2" data-id="${entry.agent_id}">
                <div class="flex-1 min-w-0">
                    <div class="roster-manage-name text-sm text-gray-100 truncate mono">${escapeHtml(entry.alias)}</div>
                </div>
                <div class="roster-manage-controls flex items-center gap-2">
                    <input class="roster-manage-select bg-gray-950 border border-gray-800 text-gray-100 text-xs px-2 py-1 rounded mono focus:ring-emerald-500/50" value="${escapeHtml(entry.role_in_op)}" placeholder="Role in Op..." data-role="role-input" data-id="${entry.agent_id}">
                    <button class="roster-remove-btn text-rose-400 hover:text-rose-300 text-sm px-2" data-role="remove-agent" data-id="${entry.agent_id}" aria-label="Remove">✕</button>
                </div>
            </div>`).join('');
    };

    const renderCandidates = () => {
        if (!state.candidates.length) {
            candidatesListEl.innerHTML = '<div class="text-gray-600 text-xs mono tracking-wide text-center py-6">// NO MATCHING AGENTS</div>';
            return;
        }
        candidatesListEl.innerHTML = state.candidates.map(cand => `
            <button class="roster-candidate flex items-start justify-between gap-3 bg-gray-950/60 border border-gray-800/80 rounded px-3 py-2 transition hover:border-emerald-500/50 w-full text-left" data-role="add-agent" data-id="${cand.id}" data-alias="${escapeHtml(cand.alias)}">
                <div class="text-sm text-gray-100 mono truncate">${escapeHtml(cand.alias)}</div>
                <div class="text-[10px] text-gray-500 uppercase mono tracking-wide">AGENT #${cand.id}</div>
            </button>`).join('');
    };

    const loadData = async (query = '') => {
        const res = await api(`/api/loom/operations/${operationId}/manage-personnel/?q=${encodeURIComponent(query)}`);
        if (!res.ok) { showMessage('Failed to load personnel data.', 'error'); return; }
        const data = await res.json();
        
        if (!query) { // Initial load
            state.assigned.clear();
            data.assigned.forEach(a => state.assigned.set(a.agent_id, a));
            renderAssigned();
        }
        state.candidates = data.candidates || [];
        renderCandidates();
    };

    searchInputEl.addEventListener('input', () => {
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(() => {
            const query = searchInputEl.value.trim();
            if (query.length < 2) {
                candidatesListEl.innerHTML = 'Start typing to search...';
                return;
            }
            loadData(query);
        }, 300);
    });

    assignedListEl.addEventListener('input', (e) => {
        const input = e.target.closest('[data-role="role-input"]');
        if (!input) return;
        const agentId = Number(input.dataset.id);
        if (state.assigned.has(agentId)) {
            state.assigned.get(agentId).role_in_op = input.value;
        }
    });

    assignedListEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-role="remove-agent"]');
        if (!btn) return;
        const agentId = Number(btn.dataset.id);
        state.assigned.delete(agentId);
        renderAssigned();
    });

    candidatesListEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-role="add-agent"]');
        if (!btn) return;
        const agentId = Number(btn.dataset.id);
        const alias = btn.dataset.alias;
        if (!state.assigned.has(agentId)) {
            state.assigned.set(agentId, { agent_id: agentId, alias, role_in_op: 'Field Agent' });
            renderAssigned();
            // Remove from candidates to prevent re-adding
            state.candidates = state.candidates.filter(c => c.id !== agentId);
            renderCandidates();
        }
    });

    saveBtnEl.addEventListener('click', async () => {
        const payload = { assignments: Array.from(state.assigned.values()) };
        try {
            const res = await api(`/api/loom/operations/${operationId}/manage-personnel/`, { method: 'POST', body: JSON.stringify(payload) });
            if (!res.ok) throw new Error('Failed to update personnel.');
            showMessage('Personnel roster updated.', 'info');
            closeModal();
            openLoomOperationDetail(operationId); // Refresh the main view
        } catch (e) {
            showMessage(e.message, 'error');
        }
    });

    loadData(); // Initial load
}

async function openManageTargetsModal(operationId) {
    const opRes = await api(`/api/loom/operations/${operationId}/`);
    if (!opRes.ok) {
        showMessage('Failed to load operation data.', 'error');
        return;
    }
    const operation = await opRes.json();

    const html = `
    <div class="manage-roster-modal cy-panel rounded-lg overflow-hidden" style="min-width: 960px;">
      <div class="modal-title py-4 border-b border-gray-800 flex items-center justify-between bg-gray-950/70 px-4">
        <div class="text-lg font-semibold text-gray-100 tracking-wide mono">» MANAGE TARGETS</div>
      </div>
      <div class="modal-body grid grid-cols-1 lg:grid-cols-2 gap-4 py-4 px-4 bg-gray-950/40">
        <section class="roster-column flex flex-col gap-3">
          <header class="flex items-center justify-between">
            <div class="text-sm text-gray-300 tracking-wide mono">» DESIGNATED TARGETS</div>
            <div class="text-xs text-gray-500 mono">// <span id="op-target-count">0</span> DESIGNATED</div>
          </header>
          <div id="op-assigned-targets-list" class="roster-manage-list cy-scroll-slab bg-gray-900/40 border border-gray-800 rounded p-3 space-y-2 overflow-y-auto" style="max-height: 420px;"></div>
        </section>
        <section class="roster-column flex flex-col gap-3">
          <header class="flex flex-col gap-2">
            <div class="text-sm text-gray-300 tracking-wide mono">» FIND TARGETS (INDEX & SCALES)</div>
            <input id="op-target-search" class="w-full px-3 py-2 rounded bg-gray-950 border border-gray-800 text-gray-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/60 mono placeholder:text-gray-500" placeholder="Search Index & Scales…" autocomplete="off">
          </header>
          <div id="op-target-candidates-list" class="roster-manage-list cy-scroll-slab bg-gray-900/40 border border-gray-800 rounded p-3 space-y-2 text-sm text-gray-400 overflow-y-auto mono" style="max-height: 420px;">Start typing to search...</div>
        </section>
      </div>
      <footer class="py-4 border-t border-gray-800 bg-gray-950/70 flex justify-end gap-3 px-4">
        <button data-action="close-modal" class="terminal-btn abort">// CANCEL</button> 
        <button id="op-targets-save" class="terminal-btn commit">// COMMIT TARGETS</button>
      </footer>
    </div>`;
    openModal(html);

    const state = {
        assigned: new Map(), // key: 'faction-1' or 'profile-2', value: { id, name, type }
        searchTimer: null,
    };

    const assignedListEl = qs('#op-assigned-targets-list');
    const candidatesListEl = qs('#op-target-candidates-list');
    const searchInputEl = qs('#op-target-search');
    const saveBtnEl = qs('#op-targets-save');
    const countEl = qs('#op-target-count');

    const renderAssigned = () => {
        const assigned = Array.from(state.assigned.values()).sort((a, b) => a.name.localeCompare(b.name));
        countEl.textContent = assigned.length;
        if (!assigned.length) {
            assignedListEl.innerHTML = '<div class="text-gray-600 text-xs mono tracking-wide text-center py-6">// NO TARGETS DESIGNATED</div>';
            return;
        }
        assignedListEl.innerHTML = assigned.map(entry => `
            <div class="roster-manage-item flex items-center gap-3 bg-gray-950/70 border border-gray-800/80 rounded px-3 py-2" data-key="${entry.type}-${entry.id}">
                <div class="roster-manage-name text-sm text-gray-100 truncate mono">${entry.type === 'faction' ? '⚖️' : '👤'} ${escapeHtml(entry.name)}</div>
                <div class="flex-grow"></div>
                <button data-role="remove-target" data-key="${entry.type}-${entry.id}" class="roster-remove-btn text-rose-400 hover:text-rose-300 text-sm px-2" aria-label="Remove">✕</button>
            </div>
        `).join('');
    };

    const renderCandidates = (candidates = []) => {
        if (!candidates.length) {
            candidatesListEl.innerHTML = '<div class="text-gray-600 text-xs mono tracking-wide text-center py-6">// NO MATCHING TARGETS</div>';
            return;
        }
        candidatesListEl.innerHTML = candidates.map(cand => `
            <button class="roster-candidate flex items-start justify-between gap-3 bg-gray-950/60 border border-gray-800/80 rounded px-3 py-2 transition hover:border-emerald-500/50 w-full text-left" data-role="add-target" data-id="${cand.id}" data-name="${escapeHtml(cand.name)}" data-type="${cand.type}">
                <div class="text-sm text-gray-100 mono truncate">${cand.type === 'faction' ? '⚖️' : '👤'} ${escapeHtml(cand.name)}</div>
                <div class="text-[10px] text-gray-500 uppercase mono tracking-wide">${cand.type} #${cand.id}</div>
            </button>`).join('');
    };

    const loadData = async (query = '') => {
        const res = await api(`/api/loom/operations/${operationId}/manage-targets/?q=${encodeURIComponent(query)}`);
        if (!res.ok) { showMessage('Failed to load target data.', 'error'); return; }
        const data = await res.json();
        
        if (!query) { // Initial load
            state.assigned.clear();
            (data.assigned_profiles || []).forEach(p => state.assigned.set(`profile-${p.id}`, { id: p.id, name: p.full_name, type: 'profile' }));
            (data.assigned_factions || []).forEach(f => state.assigned.set(`faction-${f.id}`, { id: f.id, name: f.name, type: 'faction' }));
            renderAssigned();
        }
        
        const candidates = [
            ...(data.candidate_profiles || []).map(p => ({ id: p.id, name: p.full_name, type: 'profile' })),
            ...(data.candidate_factions || []).map(f => ({ id: f.id, name: f.name, type: 'faction' }))
        ];
        renderCandidates(candidates);
    };

    searchInputEl.addEventListener('input', () => {
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(() => {
            const query = searchInputEl.value.trim();
            if (query.length < 2) {
                candidatesListEl.innerHTML = 'Start typing to search...';
                return;
            }
            loadData(query);
        }, 300);
    });

    assignedListEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-role="remove-target"]');
        if (!btn) return;
        const key = btn.dataset.key;
        state.assigned.delete(key);
        renderAssigned();
    });

    candidatesListEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-role="add-target"]');
        if (!btn) return;
        const id = Number(btn.dataset.id);
        const name = btn.dataset.name;
        const type = btn.dataset.type;
        const key = `${type}-${id}`;

        if (!state.assigned.has(key)) {
            state.assigned.set(key, { id, name, type });
            renderAssigned();
            // Visually remove from candidates
            btn.remove();
        }
    });

    saveBtnEl.addEventListener('click', async () => {
        const payload = {
            profile_ids: [],
            faction_ids: []
        };
        for (const entry of state.assigned.values()) {
            if (entry.type === 'profile') {
                payload.profile_ids.push(entry.id);
            } else if (entry.type === 'faction') {
                payload.faction_ids.push(entry.id);
            }
        }

        try {
            const res = await api(`/api/loom/operations/${operationId}/manage-targets/`, { method: 'POST', body: JSON.stringify(payload) });
            if (!res.ok) throw new Error('Failed to update targets.');
            showMessage('Operation targets updated.', 'info');
            closeModal();
            openLoomOperationDetail(operationId); // Refresh the main view
        } catch (e) {
            showMessage(e.message, 'error');
        }
    });

    loadData(); // Initial load
}