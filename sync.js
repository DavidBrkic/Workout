/*
 * JAAFIT Phone Control MVP · Firebase Authentication REST + Realtime Database REST
 * Uses HTTPS GET/POST/PUT/DELETE for compatibility with 2020 Samsung TVs.
 * TV owns and saves workout history; phone transmits commands, not workout history.
 * No Firebase SDK, no bundler, no service-account credentials.
 */
(function () {
  'use strict';
  var role = document.body.getAttribute('data-role');
  var cfg = window.WORKOUT_FIREBASE || {};
  var configured = cfg.apiKey && cfg.apiKey.indexOf('PASTE_') !== 0 && cfg.databaseURL && cfg.databaseURL.indexOf('YOUR-') === -1;
  var storeAuth = 'jaafit-firebase-auth-v1';
  var session = null, busy = false, pollBusy = false, lastError = '',
      lastPublish = 0, publishTimer = null, publishPending = false,
      pollingTimer = null, isProcessing = false, loggedIn = false;
  var $ = function (id) { return document.getElementById(id); };
  var safe = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); };
  var base = String(cfg.databaseURL || '').replace(/\/+$/, '');

  function request(url, method, data, form) {
    var options = {method: method || 'GET', cache: 'no-store'};
    if (data !== undefined && data !== null) {
      options.headers = {'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json'};
      options.body = form ? data : JSON.stringify(data);
    }
    return fetch(url, options).then(function (r) {
      return r.text().then(function (t) {
        var parsed; try { parsed = t ? JSON.parse(t) : null; } catch (e) { parsed = t; }
        if (!r.ok) throw new Error((parsed && parsed.error && (parsed.error.message || parsed.error)) || ('HTTP ' + r.status));
        return parsed;
      });
    });
  }
  function authURL(endpoint) { return 'https://identitytoolkit.googleapis.com/v1/accounts:' + endpoint + '?key=' + encodeURIComponent(cfg.apiKey); }
  function saveSession(s) { session = s; try { localStorage.setItem(storeAuth, JSON.stringify(s)); } catch (e) {} }
  function readSession() { try { return JSON.parse(localStorage.getItem(storeAuth)); } catch (e) { return null; } }
  function hasSession() { return !!(session && session.uid && session.refreshToken); }
  function status(message, bad) {
    var el = $('sync-status'); if (el) { el.textContent = message; el.style.color = bad ? '#ffad98' : '#b6ef66'; }
  }
  function failMessage(error) {
    var msg = error && error.message || String(error);
    if (msg.indexOf('INVALID_LOGIN_CREDENTIALS') >= 0 || msg.indexOf('INVALID_PASSWORD') >= 0) return 'Email or password is incorrect.';
    if (msg.indexOf('PERMISSION_DENIED') >= 0) return 'Database permission denied. Check your Firebase database rules.';
    if (msg.indexOf('API_KEY_INVALID') >= 0 || msg.indexOf('INVALID_API_KEY') >= 0) return 'The Firebase API key is invalid.';
    return msg;
  }
  function setForm(message) {
    var modal = $('auth-screen'); if (!modal) return;
    var explain = $('auth-message'); if (explain) explain.textContent = message || '';
    modal.style.display = 'flex';
  }
  function closeForm() { var el = $('auth-screen'); if (el) el.style.display = 'none'; }
  function refresh() {
    if (!hasSession()) return Promise.reject(new Error('Please sign in.'));
    var form = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(session.refreshToken);
    return request('https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(cfg.apiKey), 'POST', form, true).then(function (res) {
      saveSession({ uid: res.user_id, idToken: res.id_token, refreshToken: res.refresh_token, expires: Date.now() + Number(res.expires_in || 3600) * 1000 });
      return session.idToken;
    });
  }
  function getToken() {
    if (!hasSession()) return Promise.reject(new Error('Not signed in.'));
    if (session.idToken && session.expires > Date.now() + 120000) return Promise.resolve(session.idToken);
    return refresh();
  }
  function db(path, method, data) {
    return getToken().then(function (token) {
      return request(base + '/users/' + encodeURIComponent(session.uid) + '/' + path + '.json?auth=' + encodeURIComponent(token), method, data);
    });
  }
  function signedOut() {
    session = null; loggedIn = false;
    try { localStorage.removeItem(storeAuth); } catch (e) {}
    clearInterval(pollingTimer); pollingTimer = null;
    setForm('Sign in using the SAME Firebase account on both screens.');
    status('NOT CONNECTED', true);
  }
  function showSignedIn() {
    loggedIn = true; closeForm();
    var who = $('account-email'); if (who) who.textContent = session.email || 'Account connected';
    status(role === 'tv' ? 'PHONE SYNC READY' : 'CONNECTING…');
    if (pollingTimer) clearInterval(pollingTimer);
    if (role === 'tv') {
      sendLive();
      checkCommands();
      pollingTimer = setInterval(checkCommands, 1050);
      setInterval(function () { if (loggedIn) sendLive(); }, 20000);
    } else {
      checkLive();
      pollingTimer = setInterval(checkLive, 1150);
    }
  }
  function signIn(email, password) {
    if (busy) return; busy = true; status('SIGNING IN…');
    request(authURL('signInWithPassword'), 'POST', {email: email, password: password, returnSecureToken: true}).then(function (res) {
      saveSession({ uid: res.localId, email: email, idToken: res.idToken, refreshToken: res.refreshToken, expires: Date.now() + Number(res.expiresIn || 3600) * 1000 });
      showSignedIn();
    }).catch(function (err) { setForm(failMessage(err)); status('SIGN-IN FAILED', true); }).then(function () { busy = false; });
  }
  function bindAuth() {
    var form = $('sync-login');
    if (form) form.addEventListener('submit', function (e) {
      e.preventDefault(); signIn($('sync-email').value.trim(), $('sync-password').value);
      $('sync-password').value = '';
    });
    var logout = $('sync-logout'); if (logout) logout.addEventListener('click', signedOut);
    var offline = $('sync-offline'); if (offline) offline.addEventListener('click', function () { closeForm(); status('OFFLINE · PHONE CONTROL OFF', true); });
  }
  function liveSnapshot() {
    var x = active(), p = progress();
    return {
      day: state.day,
      exercise: state.exercise,
      name: x.name,
      tool: x.tool,
      workout: workouts[state.day].name,
      goalSets: x.sets,
      completed: logsFor(x.id).length,
      reps: Number($('rep-input').value) || x.defaultReps,
      resistance: $('band-input').value,
      tip: x.tip,
      progress: Math.round(100 * p.done / p.total),
      restRunning: restRunning,
      restEnd: restEnd,
      restRemaining: restRunning ? Math.max(0, Math.ceil((restEnd - Date.now()) / 1000)) : restRemaining,
      updatedAt: Date.now()
    };
  }
  function sendLive() {
    if (role !== 'tv' || !loggedIn) return;
    var elapsed = Date.now() - lastPublish;
    if (elapsed < 450) {
      publishPending = true;
      if (!publishTimer) publishTimer = setTimeout(function () { publishTimer = null; if (publishPending) { publishPending = false; sendLive(); } }, 500 - elapsed);
      return;
    }
    lastPublish = Date.now();
    db('live', 'PUT', liveSnapshot()).then(function () { status('PHONE SYNC READY'); }).catch(function (err) { status('SYNC ERROR: ' + failMessage(err), true); });
  }
  function commandRun(cmd) {
    // Commands are never interpreted as executable code; only these actions are allowed.
    var a = cmd && cmd.action;
    if (a === 'next') setActive(state.exercise + 1);
    else if (a === 'prev') setActive(state.exercise - 1);
    else if (a === 'day') { var d = Number(cmd.value); if (d >= 0 && d <= 2 && progress().done === 0) daySelect(d); }
    else if (a === 'setreps') { var r = Math.round(Number(cmd.value)); if (r >= 1 && r <= 100) { $('rep-input').value = r; state.lastReps[active().id] = r; persist(); renderRemote(); } }
    else if (a === 'setresistance') { var text = String(cmd.value || '').slice(0, 50); $('band-input').value = text; state.resistance[active().id] = text; persist(); }
    else if (a === 'log') { var reps = Number(cmd.reps), resistance = String(cmd.resistance || '').slice(0, 50); if (reps >= 1 && reps <= 100) { $('rep-input').value = reps; $('band-input').value = resistance; logSet(); } }
    else if (a === 'undo') undoSet();
    else if (a === 'rest') toggleRest();
    else if (a === 'resetrest') resetRest();
    else if (a === 'finish') finish(true);
    sendLive();
  }
  function checkCommands() {
    if (!loggedIn || pollBusy) return; pollBusy = true;
    db('commands', 'GET').then(function (all) {
      var keys = Object.keys(all || {}).sort();
      var queue = keys.reduce(function (chain, key) {
        return chain.then(function () {
          var c = all[key];
          // Drop stale commands (e.g. TV has been turned off for a day).
          if (c && c.at && Date.now() - c.at < 120000 && Date.now() - c.at > -30000) commandRun(c);
          return db('commands/' + encodeURIComponent(key), 'DELETE').catch(function () {});
        });
      }, Promise.resolve());
      return queue;
    }).catch(function (err) { status('SYNC ERROR: ' + failMessage(err), true); }).then(function () { pollBusy = false; });
  }
  function sendCommand(action, value) {
    if (!loggedIn) { setForm('Sign in to connect the phone to the TV.'); return Promise.resolve(); }
    var command = {action: action, at: Date.now()};
    if (action === 'log') {
      command.reps = Number($('phone-reps').value) || 0;
      command.resistance = String($('phone-resistance').value || '').slice(0, 50);
      if (command.reps < 1 || command.reps > 100) { status('ENTER 1–100 REPS', true); return Promise.resolve(); }
    } else if (value !== undefined) command.value = value;
    status('SENDING…');
    return db('commands', 'POST', command).then(function () { status('SENT · CHECK TV'); }).catch(function (err) { status('ERROR: ' + failMessage(err), true); });
  }
  var lastLiveAt = 0;
  var lastLiveKey = '';
  function checkLive() {
    if (!loggedIn || pollBusy) return; pollBusy = true;
    db('live', 'GET').then(function (data) {
      if (!data) { status('WAITING FOR TV…', true); return; }
      var age = Date.now() - data.updatedAt;
      lastLiveAt = data.updatedAt;
      if (age > 60000) status('TV MAY BE DISCONNECTED', true);
      else status('CONNECTED · WORKOUT ' + safe(data.workout));
      $('phone-title').textContent = data.name || '—';
      $('phone-tool').textContent = data.tool || '';
      $('phone-tip').textContent = data.tip || '';
      $('phone-set').textContent = (data.completed || 0) + ' / ' + (data.goalSets || 0) + ' sets';
      $('phone-progress').textContent = (data.progress || 0) + '% complete';
      $('phone-day').textContent = 'WORKOUT ' + (data.workout || 'A');
      var currentKey = data.day + ':' + data.exercise;
      if (currentKey !== lastLiveKey) {
        $('phone-reps').value = data.reps || 12;
        $('phone-resistance').value = data.resistance || '';
        lastLiveKey = currentKey;
      }
      if (document.activeElement !== $('phone-reps') && document.activeElement !== $('phone-resistance') && (Date.now() - lastInputAt) > 2500) {
        $('phone-reps').value = data.reps || 12;
        $('phone-resistance').value = data.resistance || '';
      }
      lastTimer = data;
      tickTimer();
    }).catch(function (err) { status('SYNC ERROR: ' + failMessage(err), true); }).then(function () { pollBusy = false; });
  }
  var lastTimer = null;
  var lastInputAt = 0;
  function tickTimer() {
    if (role !== 'phone' || !lastTimer || !$('phone-timer')) return;
    var n = lastTimer.restRunning ? Math.ceil((lastTimer.restEnd - Date.now()) / 1000) : lastTimer.restRemaining;
    n = Math.max(0, n || 0);
    $('phone-timer').textContent = ('0' + Math.floor(n / 60)).slice(-2) + ':' + ('0' + (n % 60)).slice(-2);
  }
  function bindPhone() {
    function bind(id, action, getValue) {
      var el = $(id); if (el) el.addEventListener('click', function () { sendCommand(action, getValue && getValue()); });
    }
    bind('phone-prev', 'prev'); bind('phone-next', 'next'); bind('phone-log', 'log');
    bind('phone-undo', 'undo'); bind('phone-rest', 'rest'); bind('phone-reset', 'resetrest');
    var finishButton = $('phone-finish'); if (finishButton) finishButton.addEventListener('click', function () {
      if (window.confirm('Finish and save this workout on your TV?')) sendCommand('finish');
    });
    bind('phone-day-a', 'day', function () { return 0; });
    bind('phone-day-b', 'day', function () { return 1; });
    bind('phone-day-c', 'day', function () { return 2; });
    bind('phone-less', 'setreps', function () { var n = Math.max(1, (Number($('phone-reps').value) || 12) - 1); $('phone-reps').value = n; return n; });
    bind('phone-more', 'setreps', function () { var n = Math.min(100, (Number($('phone-reps').value) || 12) + 1); $('phone-reps').value = n; return n; });
    $('phone-reps').addEventListener('input', function () { lastInputAt = Date.now(); });
    $('phone-resistance').addEventListener('input', function () { lastInputAt = Date.now(); });
    setInterval(tickTimer, 500);
  }
  function hookTV() {
    // Preserve existing workout state/history on the TV. Only send a small live snapshot.
    var oldPersist = persist;
    persist = function () { oldPersist(); sendLive(); };
    var restActions = ['startRest','stopRest','resetRest','toggleRest'];
    // Function declarations from the existing dashboard are global script bindings.
    var oldStart = startRest, oldStop = stopRest, oldReset = resetRest, oldToggle = toggleRest;
    startRest = function () { oldStart(); sendLive(); };
    stopRest = function () { oldStop(); sendLive(); };
    resetRest = function () { oldReset(); sendLive(); };
    toggleRest = function () { oldToggle(); sendLive(); };
  }
  function boot() {
    bindAuth();
    if (role === 'tv') hookTV();
    else bindPhone();
    if (!configured) {
      setForm('Setup needed: edit firebase-config.js with your Firebase Web API key and Realtime Database URL, then publish the files.');
      status('BACKEND NOT CONFIGURED', true);
      return;
    }
    session = readSession();
    if (!hasSession()) { setForm('Sign in using the SAME Firebase account on the TV and phone.'); return; }
    refresh().then(showSignedIn).catch(function (e) { signedOut(); setForm('Session expired. Please sign in again. ' + failMessage(e)); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
