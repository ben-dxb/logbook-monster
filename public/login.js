'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const ERRORS = {
    google_off: 'Google sign-in isn’t set up on this server.',
    google_cancelled: 'Google sign-in was cancelled.',
    google_state: 'That sign-in link expired. Try again.',
    google_failed: 'Google sign-in didn’t work. Try again.',
    google_unverified: 'Your Google account’s email isn’t verified.',
    not_allowed: 'This account isn’t allowed to use this app.',
  };
  let csrf = '', mode = 'login';
  const showErr = msg => { $('err').textContent = msg; $('err').hidden = !msg; };

  const code = new URLSearchParams(location.search).get('error');
  if (code) { showErr(ERRORS[code] || 'Sign-in failed.'); history.replaceState(null, '', '/login'); }

  fetch('/auth/config', { credentials: 'same-origin' }).then(r => r.json()).then(c => {
    if (c.signedIn) { location.replace('/' + location.hash); return; }
    csrf = c.csrf;
    $('google').hidden = $('or').hidden = !c.google;
    $('switch').hidden = !c.registration;
  }).catch(() => showErr('Can’t reach the server.'));

  $('toggle').addEventListener('click', () => {
    mode = mode === 'login' ? 'register' : 'login';
    const reg = mode === 'register';
    $('namef').hidden = !reg;
    $('submit').textContent = reg ? 'Create account' : 'Sign in';
    $('toggle').textContent = reg ? 'I already have an account' : 'Create an account';
    $('intro').textContent = reg ? 'Pick a password of at least 10 characters.' : 'Sign in to see your days, history and weight.';
    $('password').autocomplete = reg ? 'new-password' : 'current-password';
    showErr('');
  });

  $('form').addEventListener('submit', async e => {
    e.preventDefault();
    showErr('');
    const body = { email: $('email').value.trim(), password: $('password').value, name: $('name').value.trim() };
    if (!body.email || !body.password) return showErr('Enter your email and password.');
    $('submit').disabled = true;
    try {
      const r = await fetch(`/auth/${mode}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { location.replace('/' + location.hash); return; }
      if (r.status === 403 && /session/i.test(j.error || '')) { location.reload(); return; }
      showErr(j.error || 'Sign-in failed.');
    } catch { showErr('Can’t reach the server.'); }
    $('submit').disabled = false;
  });
})();
