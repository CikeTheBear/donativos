// app.js — Toda la lógica del frontend.
//
// Es una SPA (single-page application) mínima: una sola página HTML con
// secciones que se muestran/ocultan según la pestaña activa. El estado
// vive en el servidor; aquí solo pedimos datos con fetch() y pintamos.

// ─── Helpers ────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);

/**
 * Wrapper de fetch para la API: envía/recibe JSON y convierte los
 * errores HTTP en excepciones con el mensaje que mandó el servidor,
 * para poder mostrarlos directamente en los formularios.
 */
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 401 fuera del login = sesión caducada: volvemos a la pantalla de entrada.
    if (res.status === 401 && path !== '/api/login') showLogin();
    throw new Error(data.error || 'Error de conexión');
  }
  return data;
}

// escape básico: los datos (nombres, notas) se insertan en HTML, y sin
// esto un texto malicioso como "<script>" se ejecutaría (XSS).
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtNum(n) {
  return new Intl.NumberFormat('es-VE', { maximumFractionDigits: 2 }).format(n);
}

const CURRENCY_LABEL = { USD: '$', EUR: '€', VES: 'Bs' };

let currentUser = null;

// ─── Login / logout ─────────────────────────────────────────────────

function showLogin() {
  currentUser = null;
  $('#view-login').hidden = false;
  $('#view-app').hidden = true;
}

function showApp() {
  $('#view-login').hidden = true;
  $('#view-app').hidden = false;
  $('#user-name').textContent = currentUser.name;
  // La pestaña Usuarios solo existe para admins.
  $('.admin-only').hidden = currentUser.role !== 'admin';
  switchTab('resumen');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#login-error');
  errEl.hidden = true;
  try {
    currentUser = await api('/api/login', {
      method: 'POST',
      body: { username: $('#login-username').value.trim(), password: $('#login-password').value },
    });
    $('#login-password').value = '';
    showApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// ─── Navegación por pestañas ────────────────────────────────────────

// Cada pestaña tiene una función que recarga sus datos al entrar, así
// siempre ves información fresca sin necesidad de refrescar la página.
const tabLoaders = {
  resumen: loadSummary,
  registrar: loadRegisterForm,
  historial: loadHistory,
  usuarios: loadUsers,
  cuenta: () => {},
};

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) =>
    p.hidden = p.id !== `tab-${name}`);
  tabLoaders[name]();
}

$('#main-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) switchTab(tab.dataset.tab);
});

// ─── Resumen (dashboard) ────────────────────────────────────────────

async function loadSummary() {
  const { stock, money } = await api('/api/summary');

  // Tarjetas de dinero: una por moneda con movimiento registrado.
  $('#money-cards').innerHTML = money.length
    ? money.map((m) => `
        <div class="money-card">
          <div class="currency">${esc(m.currency)}</div>
          <div class="amount">${CURRENCY_LABEL[m.currency]} ${fmtNum(m.disponible)}</div>
          <div class="detail">recibido ${fmtNum(m.recibido)} · entregado ${fmtNum(m.entregado)}</div>
        </div>`).join('')
    : '<p class="empty-note">Sin movimientos de dinero todavía.</p>';

  // Tabla de stock agrupada por categoría: la categoría se pinta como
  // fila separadora solo cuando cambia respecto a la fila anterior.
  const tbody = $('#stock-table tbody');
  let lastCategory = null;
  tbody.innerHTML = stock.map((r) => {
    const catRow = r.category !== lastCategory
      ? `<tr class="cat-row"><td colspan="5">${esc(r.category)}</td></tr>` : '';
    lastCategory = r.category;
    return catRow + `
      <tr>
        <td>${esc(r.name)}</td>
        <td>${esc(r.category)}</td>
        <td class="num">${fmtNum(r.entradas)}</td>
        <td class="num">${fmtNum(r.salidas)}</td>
        <td class="num ${r.stock <= 0 ? 'stock-zero' : ''}">${fmtNum(r.stock)} ${esc(r.unit)}</td>
      </tr>`;
  }).join('');

  $('#stock-table').hidden = stock.length === 0;
  $('#stock-empty').hidden = stock.length > 0;
}

// ─── Registrar movimientos ──────────────────────────────────────────

let registerKind = 'goods'; // 'goods' | 'money'

function setRegisterKind(kind) {
  registerKind = kind;
  $('#kind-goods').classList.toggle('active', kind === 'goods');
  $('#kind-money').classList.toggle('active', kind === 'money');
  $('#form-goods').hidden = kind !== 'goods';
  $('#form-money').hidden = kind !== 'money';
}

$('#kind-goods').addEventListener('click', () => setRegisterKind('goods'));
$('#kind-money').addEventListener('click', () => setRegisterKind('money'));

async function loadRegisterForm() {
  // Fecha de hoy por defecto en ambos formularios.
  const today = new Date().toISOString().slice(0, 10);
  $('#goods-date').value = today;
  $('#money-date').value = today;
  await refreshItemsSelect();
}

async function refreshItemsSelect(selectId = null) {
  const items = await api('/api/items');
  const select = $('#goods-item');
  select.innerHTML = '<option value="">— Elegir artículo —</option>' +
    items.map((i) =>
      `<option value="${i.id}">${esc(i.name)} (${esc(i.category)}, ${esc(i.unit)})</option>`
    ).join('');
  if (selectId) select.value = selectId;
}

// La etiqueta del campo "party" cambia según el tipo: en una entrada
// preguntas quién donó; en una salida, a dónde va.
function updatePartyLabel(radioName, labelEl) {
  const type = document.querySelector(`input[name="${radioName}"]:checked`).value;
  labelEl.textContent = type === 'entrada' ? 'Donante (opcional)' : 'Destino (opcional)';
}

document.querySelectorAll('input[name="goods-type"]').forEach((r) =>
  r.addEventListener('change', () => updatePartyLabel('goods-type', $('#goods-party-label'))));
document.querySelectorAll('input[name="money-type"]').forEach((r) =>
  r.addEventListener('change', () => updatePartyLabel('money-type', $('#money-party-label'))));

// Crear artículo nuevo sin salir del formulario.
$('#btn-new-item').addEventListener('click', () => {
  $('#new-item-fields').hidden = !$('#new-item-fields').hidden;
});

$('#btn-save-item').addEventListener('click', async () => {
  const errEl = $('#goods-error');
  errEl.hidden = true;
  try {
    const item = await api('/api/items', {
      method: 'POST',
      body: {
        name: $('#new-item-name').value,
        category: $('#new-item-category').value,
        unit: $('#new-item-unit').value,
      },
    });
    // Recargamos el select y dejamos elegido el artículo recién creado.
    await refreshItemsSelect(String(item.id));
    $('#new-item-fields').hidden = true;
    $('#new-item-name').value = '';
    $('#new-item-category').value = '';
    $('#new-item-unit').value = '';
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

function flashOk(message) {
  const el = $('#register-ok');
  el.textContent = message;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 3000);
}

$('#form-goods').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#goods-error');
  errEl.hidden = true;
  try {
    await api('/api/movements', {
      method: 'POST',
      body: {
        type: document.querySelector('input[name="goods-type"]:checked').value,
        item_id: Number($('#goods-item').value),
        quantity: $('#goods-qty').value,
        party: $('#goods-party').value,
        notes: $('#goods-notes').value,
        date: $('#goods-date').value,
      },
    });
    // Limpiamos solo cantidad/notas: quien registra 20 donaciones
    // seguidas agradece no re-teclear fecha ni re-elegir tipo.
    $('#goods-qty').value = '';
    $('#goods-party').value = '';
    $('#goods-notes').value = '';
    flashOk('Movimiento registrado ✓');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

$('#form-money').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#money-error');
  errEl.hidden = true;
  try {
    await api('/api/money', {
      method: 'POST',
      body: {
        type: document.querySelector('input[name="money-type"]:checked').value,
        amount: $('#money-amount').value,
        currency: $('#money-currency').value,
        party: $('#money-party').value,
        notes: $('#money-notes').value,
        date: $('#money-date').value,
      },
    });
    $('#money-amount').value = '';
    $('#money-party').value = '';
    $('#money-notes').value = '';
    flashOk('Movimiento registrado ✓');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

// ─── Historial ──────────────────────────────────────────────────────

let historyKind = 'goods';

$('#hist-goods').addEventListener('click', () => { historyKind = 'goods'; loadHistory(); });
$('#hist-money').addEventListener('click', () => { historyKind = 'money'; loadHistory(); });

async function loadHistory() {
  $('#hist-goods').classList.toggle('active', historyKind === 'goods');
  $('#hist-money').classList.toggle('active', historyKind === 'money');

  const isGoods = historyKind === 'goods';
  const rows = await api(isGoods ? '/api/movements' : '/api/money');
  const isAdmin = currentUser.role === 'admin';

  $('#history-list').innerHTML = rows.map((m) => {
    const qty = isGoods
      ? `${fmtNum(m.quantity)} ${esc(m.unit)}`
      : `${CURRENCY_LABEL[m.currency]} ${fmtNum(m.amount)}`;
    const what = isGoods ? esc(m.item_name) : 'Dinero';
    return `
      <div class="history-row">
        <span class="stamp stamp-${m.type}">${m.type}</span>
        <span class="what">${what}</span>
        <span class="qty">${qty}</span>
        ${isAdmin ? `<button class="btn-delete" data-id="${m.id}">borrar</button>` : ''}
        <span class="meta">
          ${esc(m.date)} · registró ${esc(m.user_name)}
          ${m.party ? ` · ${m.type === 'entrada' ? 'donante' : 'destino'}: ${esc(m.party)}` : ''}
          ${m.notes ? ` · ${esc(m.notes)}` : ''}
        </span>
      </div>`;
  }).join('');

  $('#history-empty').hidden = rows.length > 0;
}

// Borrado (solo admin): delegación de eventos sobre la lista para no
// re-registrar listeners cada vez que se repinta el historial.
$('#history-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-delete');
  if (!btn) return;
  if (!confirm('¿Borrar este movimiento? El stock se recalculará.')) return;
  const base = historyKind === 'goods' ? '/api/movements' : '/api/money';
  try {
    await api(`${base}/${btn.dataset.id}`, { method: 'DELETE' });
    loadHistory();
  } catch (err) {
    alert(err.message);
  }
});

// ─── Usuarios (solo admin) ──────────────────────────────────────────

async function loadUsers() {
  const users = await api('/api/users');
  $('#users-list').innerHTML = users.map((u) => `
    <div class="user-row">
      <span class="name">${esc(u.name)} <small>(${esc(u.username)})</small></span>
      <span class="role">${esc(u.role)}</span>
      ${u.id !== currentUser.id
        ? `<button class="btn-delete" data-id="${u.id}">eliminar</button>` : ''}
    </div>`).join('');
}

$('#users-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-delete');
  if (!btn) return;
  if (!confirm('¿Eliminar este usuario?')) return;
  try {
    await api(`/api/users/${btn.dataset.id}`, { method: 'DELETE' });
    loadUsers();
  } catch (err) {
    alert(err.message);
  }
});

$('#form-user').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#user-error');
  errEl.hidden = true;
  try {
    await api('/api/users', {
      method: 'POST',
      body: {
        name: $('#user-fullname').value,
        username: $('#user-username').value,
        password: $('#user-password').value,
        role: $('#user-role').value,
      },
    });
    $('#form-user').reset();
    loadUsers();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

// ─── Cuenta: cambio de contraseña ───────────────────────────────────

$('#form-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#pw-error');
  const okEl = $('#pw-ok');
  errEl.hidden = true;
  okEl.hidden = true;
  try {
    await api('/api/me/password', {
      method: 'POST',
      body: { current: $('#pw-current').value, next: $('#pw-next').value },
    });
    $('#form-password').reset();
    okEl.hidden = false;
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

// ─── Arranque: ¿hay sesión activa? ──────────────────────────────────

// Al cargar la página preguntamos al servidor si nuestra cookie de
// sesión sigue siendo válida. Si sí, directo a la app; si no, login.
(async () => {
  try {
    currentUser = await api('/api/me');
    showApp();
  } catch {
    showLogin();
  }
})();
