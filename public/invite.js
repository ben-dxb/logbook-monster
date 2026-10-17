'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const token = location.hash.slice(1);
  let csrf = '';
  const showErr = msg => { $('err').textContent = msg; $('err').hidden = !msg; };
  const post = (url, body) => fetch(url, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify(body),
  }).then(async r => ({ ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) }));

  (async () => {
    if (!token) { $('intro').textContent = ''; return showErr('This link is missing its invite code. Open the link from your invite email again.'); }
    try {
      csrf = (await (await fetch('/auth/config', { credentials: 'same-origin' })).json()).csrf;
      const { ok, j } = await post('/auth/invite/check', { token });
      if (!ok) { $('intro').textContent = ''; return showErr(j.error || 'This invite link doesn’t work.'); }
      $('intro').textContent = `You’ve been invited as ${j.email}. Set up how you’ll sign in.`;
      $('email').value = j.email;
      if (j.name) $('name').value = j.name;
      $('google').hidden = $('or').hidden = !j.google;
      $('google').textContent = `Continue with Google (${j.email})`;
      $('form').hidden = false;
    } catch { showErr('Can’t reach the server.'); }
  })();

  const pwWhy = el => !el.value ? 'Pick a password' : el.value.length < 10 ? 'Use at least 10 characters' : '';
  $('form').addEventListener('submit', async e => {
    e.preventDefault();
    showErr('');
    if (!fieldErrors($('form'), [[pwWhy($('password')) && $('password'), pwWhy($('password')), { check: pwWhy }]])) return;
    if ($('submit').disabled) return;
    const done = busyOn($('submit'), 'Creating your account…');
    try {
      const { ok, status, j } = await post('/auth/invite/accept', { token, password: $('password').value, name: $('name').value.trim() });
      if (ok) { location.replace('/#dash'); return; }
      if (status === 403 && /session/i.test(j.error || '')) { location.reload(); return; }
      done();
      if (!errToField({ message: j.error || '' }, [[/^password|characters/i, $('password')], [/^name/i, $('name')]])) showErr(j.error || 'That didn’t work.');
      return;
    } catch { showErr('Can’t reach the server.'); }
    done();
  });
})();
