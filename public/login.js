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
  if (code) { showErr(ERRORS[code] || 'Sign-in failed.'); history.replaceState(null, '', '/login' + location.hash); }
  if (new URLSearchParams(location.search).has('second')) history.replaceState(null, '', '/login' + location.hash);

  /* the password (or Google) was right and the account has a second step on: ask for a code */
  const askCode = () => {
    $('form').hidden = $('google').hidden = $('or').hidden = $('switch').hidden = true;
    $('second').hidden = false;
    $('intro').textContent = 'Enter the 6-digit code your authenticator app shows for Logbook Monster.';
    $('code').focus();
  };

  fetch('/auth/config', { credentials: 'same-origin' }).then(r => r.json()).then(c => {
    if (c.signedIn) { location.replace('/' + location.hash); return; }
    csrf = c.csrf;
    $('google').hidden = $('or').hidden = !c.google;
    $('switch').hidden = !c.registration;
    if (c.second) askCode();
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
      if (r.ok && j.second) { csrf = j.csrf; askCode(); $('submit').disabled = false; return; }
      if (r.ok) { location.replace('/' + location.hash); return; }
      if (r.status === 403 && /session/i.test(j.error || '')) { location.reload(); return; }
      showErr(j.error || 'Sign-in failed.');
    } catch { showErr('Can’t reach the server.'); }
    $('submit').disabled = false;
  });

  $('second').addEventListener('submit', async e => {
    e.preventDefault();
    showErr('');
    const v = $('code').value.trim();
    if (!v) return showErr('Enter the code.');
    $('codebtn').disabled = true;
    try {
      const r = await fetch('/auth/second', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ code: v }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        if (j.recovery) alert('You used a recovery code – it won’t work again. If you’ve lost your authenticator app, switch the second step off and set it up again from the account menu.');
        location.replace('/' + location.hash); return;
      }
      if (j.restart || (r.status === 403 && /session/i.test(j.error || ''))) { location.reload(); return; }
      showErr(j.error || 'That code didn’t work.');
      $('code').select();
    } catch { showErr('Can’t reach the server.'); }
    $('codebtn').disabled = false;
  });
  $('restart').addEventListener('click', async () => {
    try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrf } }); } catch {}
    location.reload();
  });
})();
