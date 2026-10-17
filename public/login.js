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
    rate: 'Too many sign-in attempts. Wait a few minutes and try again.',
    gone: 'This account can’t sign in here any more.',
  };
  let csrf = '', mode = 'login';
  const showErr = msg => { $('err').textContent = msg; $('err').hidden = !msg; };
  const home = () => '/' + (location.hash || '#dash');   /* the address says where you land */
  /* a fresh sign-in token (after cookies were cleared or the page sat open too long), keeping what's typed */
  const refresh = () => fetch('/auth/config', { credentials: 'same-origin' }).then(r => r.json()).then(c => { csrf = c.csrf; return !!csrf; }, () => false);

  const code = new URLSearchParams(location.search).get('error');
  if (code) { showErr(ERRORS[code] || 'Sign-in failed.'); history.replaceState(null, '', '/login' + location.hash); }
  /* after Account admin › Delete my account */
  if (new URLSearchParams(location.search).has('bye')) {
    $('intro').textContent = 'Your account and everything in it have been deleted. Goodbye – thanks for using Logbook Monster.';
    history.replaceState(null, '', '/login');
  }
  if (new URLSearchParams(location.search).has('second')) history.replaceState(null, '', '/login' + location.hash);

  /* the password (or Google) was right and the account has a second step on: ask for a code */
  const askCode = () => {
    $('form').hidden = $('google').hidden = $('or').hidden = $('switch').hidden = true;
    $('second').hidden = false;
    $('intro').textContent = 'Enter the 6-digit code your authenticator app shows for Logbook Monster.';
    $('code').focus();
  };

  fetch('/auth/config', { credentials: 'same-origin' }).then(r => r.json()).then(c => {
    if (c.signedIn) { location.replace(home()); return; }
    csrf = c.csrf;
    $('google').hidden = $('or').hidden = !c.google;
    $('switch').hidden = !c.registration;
    if (c.contact) { $('contact').href = 'mailto:' + c.contact; $('contact').hidden = false; }
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

  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const emailWhy = el => { const v = el.value.trim(); return !v ? 'Enter your email address' : EMAIL.test(v) ? '' : 'Enter an email address like name@example.com'; };
  $('form').addEventListener('submit', async e => {
    e.preventDefault();
    showErr('');
    const body = { email: $('email').value.trim(), password: $('password').value, name: $('name').value.trim() };
    const reg = mode === 'register';
    if (!fieldErrors($('form'), [
      [emailWhy($('email')) && $('email'), emailWhy($('email')), { check: emailWhy }],
      [(!body.password || (reg && body.password.length < 10)) && $('password'), !body.password ? 'Enter your password' : 'Use at least 10 characters',
        { check: el => !el.value ? 'Enter your password' : reg && el.value.length < 10 ? 'Use at least 10 characters' : '' }],
    ])) return;
    if ($('submit').disabled) return;
    const done = busyOn($('submit'), reg ? 'Creating account…' : 'Signing in…');
    try {
      const send = () => fetch(`/auth/${mode}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify(body),
      });
      let r = await send(), j = await r.json().catch(() => ({}));
      /* the sign-in token ran out: get a new one and try once more, without clearing the form */
      if (r.status === 403 && /session/i.test(j.error || '') && await refresh()) { r = await send(); j = await r.json().catch(() => ({})); }
      if (r.ok && j.second) { csrf = j.csrf; done(); askCode(); return; }
      if (r.ok) { location.replace(home()); return; }
      done();
      if (r.status === 403 && /session/i.test(j.error || '')) showErr('This page had expired. Check that cookies are allowed for this site, then press Sign in again.');
      else if (!errToField({ message: j.error || '' }, [[/^password|characters/i, $('password')], [/valid email|email address/i, $('email')]])) showErr(j.error || 'Sign-in failed.');
      return;
    } catch { showErr('Can’t reach the server.'); }
    done();
  });

  $('second').addEventListener('submit', async e => {
    e.preventDefault();
    showErr('');
    const v = $('code').value.trim();
    if (!v) return fieldError($('code'), rec ? 'Enter one of your recovery codes' : 'Enter the 6-digit code');
    if ($('codebtn').disabled) return;
    const done = busyOn($('codebtn'), 'Checking…');
    try {
      const r = await fetch('/auth/second', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ code: v }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        if (j.recovery) await ask('You used a recovery code – it won’t work again. If you’ve lost your authenticator app, switch the second step off and set it up again from the account menu.', { title: 'Recovery code used', yes: 'Continue', only: true });
        location.replace(home()); return;
      }
      if (j.restart || (r.status === 403 && /session/i.test(j.error || ''))) { location.reload(); return; }
      done();
      if (r.status === 429) showErr(j.error || 'Too many tries.');
      else { fieldError($('code'), j.error || 'That code didn’t work'); $('code').select(); }
      return;
    } catch { showErr('Can’t reach the server.'); }
    done();
  });
  /* a recovery code (XXXXX-XXXXX) has letters: the box stops asking for the number keypad */
  let rec = false;
  $('userec').addEventListener('click', () => {
    rec = !rec;
    const c = $('code');
    c.inputMode = rec ? 'text' : 'numeric'; c.autocomplete = rec ? 'off' : 'one-time-code';
    $('codelbl').textContent = rec ? 'Recovery code (like ABCDE-FGHIJ)' : 'Code from your authenticator app';
    $('codehint').textContent = rec ? 'Found your phone?' : 'Lost your phone?';
    $('userec').textContent = rec ? 'Use a code from the app' : 'Use a recovery code';
    $('userec').setAttribute('aria-pressed', String(rec));
    clearFieldErrors($('second')); c.value = ''; c.focus();
  });
  $('restart').addEventListener('click', async () => {
    try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrf } }); } catch {}
    location.reload();
  });
})();
