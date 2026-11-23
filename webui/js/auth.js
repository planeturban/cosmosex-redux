// Web interface login (ce-atari patch 0023, /api/v1/auth/*). Loaded first by
// app.js: any API call answered with 401 (not logged in, or the login ran
// out) goes to the login page, which comes back here afterwards. Shows the
// "Log out" links when a login is in use.

const realFetch = window.fetch.bind(window);
let leaving = false;

function toLogin() {
  if (leaving) return;
  leaving = true;
  const next = location.pathname + location.search + location.hash;
  location.href = `/login.html?next=${encodeURIComponent(next)}`;
}

window.fetch = async (input, init) => {
  const r = await realFetch(input, init);
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const path = url.startsWith('http') ? new URL(url).pathname : url;
  if (r.status === 401 && (path.startsWith('/api/') || path.startsWith('/app/')) && !path.startsWith('/api/v1/auth/')) toLogin();
  return r;
};

export async function logout() {
  try { await realFetch('/api/v1/auth/logout', { method: 'POST' }); } catch (e) { /* offline: go anyway */ }
  location.href = '/login.html';
}

async function showLogout() {
  try {
    const s = await (await realFetch('/api/v1/auth/status')).json();
    const show = s.required && s.loggedIn;
    for (const el of document.querySelectorAll('[data-logout]')) {
      el.hidden = !show;
      el.addEventListener('click', (e) => { e.preventDefault(); logout(); });
    }
  } catch (e) { /* not answering: the status bar says so */ }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showLogout);
else showLogout();
