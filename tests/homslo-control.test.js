'use strict';
// Lancer avec :  node --test tests/homslo-control.test.js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mod = require('../api/homslo-control.js');

const BADGE = 'hsk_BADGE_TRES_SECRET_123456';
const APIKEY = 'CLE_PUBLIQUE_SECRETE_ABCDEF';

beforeEach(() => mod._reset());

// ── outils ────────────────────────────────────────────────────────────
function startServer(behavior) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: data });
      behavior(req, res, data);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server, requests,
        url: 'http://127.0.0.1:' + server.address().port + '/rest/v1/rpc/saas_heartbeat',
        stop: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
      })));
}
function captureLogs() {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.join(' '));
  return { lines, restore() { Object.assign(console, orig); } };
}
const envFor = (url, extra = {}) => ({
  HOMSLO_CONTROL_URL: url, HOMSLO_CONTROL_APIKEY: APIKEY, HOMSLO_CONTROL_BADGE: BADGE, ...extra,
});
const sayTrue = (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('true'); };
const noSecret = (lines) => lines.every((l) => !l.includes(BADGE) && !l.includes(APIKEY));

// ── 1. succès (true) ──────────────────────────────────────────────────
test('succès : réponse true, bon contrat, et rien d\'autre que p_key et p_version', async () => {
  const s = await startServer(sayTrue);
  const logs = captureLogs();
  try {
    const r = await mod.sendHeartbeat({ env: envFor(s.url) });
    assert.equal(r.status, 'sent');
    assert.equal(s.requests.length, 1);
    const q = s.requests[0];
    assert.equal(q.method, 'POST');
    assert.equal(q.url, '/rest/v1/rpc/saas_heartbeat');
    assert.equal(q.headers.apikey, APIKEY);
    assert.equal(q.headers['content-type'], 'application/json');
    const body = JSON.parse(q.body);
    assert.deepEqual(Object.keys(body).sort(), ['p_key', 'p_version']);
    assert.equal(body.p_key, BADGE);
    assert.equal(body.p_version, mod.APP_VERSION);
    assert.ok(noSecret(logs.lines));
  } finally { logs.restore(); await s.stop(); }
});

// ── 2. refus (false) ──────────────────────────────────────────────────
test('refus : réponse false → avertissement « badge refusé », sans le badge, sans nouvelle tentative', async () => {
  const s = await startServer((req, res) => res.end('false'));
  const logs = captureLogs();
  try {
    const r = await mod.sendHeartbeat({ env: envFor(s.url) });
    assert.equal(r.status, 'refused');
    assert.equal(s.requests.length, 1);
    assert.ok(logs.lines.some((l) => l.includes('badge refusé')));
    assert.ok(noSecret(logs.lines));
  } finally { logs.restore(); await s.stop(); }
});

// ── 3. panne réseau ───────────────────────────────────────────────────
test('panne réseau : erreur capturée, une ligne de journal, aucune exception', async () => {
  const s = await startServer(sayTrue);
  const deadUrl = s.url;
  await s.stop(); // le port est maintenant fermé
  const logs = captureLogs();
  try {
    const r = await mod.sendHeartbeat({ env: envFor(deadUrl) });
    assert.equal(r.status, 'error');
    assert.equal(logs.lines.length, 1);
    assert.ok(logs.lines[0].includes('erreur réseau'));
    assert.ok(noSecret(logs.lines));
  } finally { logs.restore(); }
});

// ── 4. dépassement de 5 secondes (test réel, dure ~5 s) ───────────────
test('dépassement de 5 s : l\'envoi est coupé à 5 s, sans bloquer', async () => {
  const s = await startServer((req, res) => setTimeout(() => { try { res.end('true'); } catch (e) {} }, 8000));
  const logs = captureLogs();
  try {
    const t0 = Date.now();
    const r = await mod.sendHeartbeat({ env: envFor(s.url) });
    const dt = Date.now() - t0;
    assert.equal(r.status, 'error');
    assert.ok(dt >= 4800 && dt < 6500, 'durée mesurée : ' + dt + ' ms');
    assert.ok(logs.lines.some((l) => l.includes('délai de 5 s dépassé')));
    assert.ok(noSecret(logs.lines));
  } finally { logs.restore(); await s.stop(); }
});

// ── 5. variable manquante ─────────────────────────────────────────────
for (const key of ['HOMSLO_CONTROL_URL', 'HOMSLO_CONTROL_APIKEY', 'HOMSLO_CONTROL_BADGE']) {
  test('variable manquante (' + key + ') : liaison désactivée proprement, rien n\'est envoyé', async () => {
    let calls = 0;
    const env = envFor('http://127.0.0.1:1/x');
    delete env[key];
    const logs = captureLogs();
    try {
      const fetchImpl = async () => { calls++; return { ok: true, status: 200, text: async () => 'true' }; };
      const r1 = await mod.sendHeartbeat({ env, fetchImpl });
      const r2 = await mod.sendHeartbeat({ env, fetchImpl });
      assert.equal(r1.status, 'disabled');
      assert.equal(r2.status, 'disabled');
      assert.equal(calls, 0);
      assert.equal(logs.lines.length, 1, 'un seul message, pas de répétition');
      assert.ok(logs.lines[0].includes(key));
      assert.ok(noSecret(logs.lines));
    } finally { logs.restore(); }
  });
}
test('variable vide (juste des espaces) : traitée comme manquante', async () => {
  const logs = captureLogs();
  try {
    const r = await mod.sendHeartbeat({ env: envFor('http://x', { HOMSLO_CONTROL_BADGE: '   ' }), fetchImpl: async () => { throw new Error('ne doit pas être appelé'); } });
    assert.equal(r.status, 'disabled');
  } finally { logs.restore(); }
});

// ── 6. le badge n'apparaît JAMAIS dans les journaux ───────────────────
test('badge et clé jamais dans les journaux, même si le serveur ou le réseau les répètent', async () => {
  const logs = captureLogs();
  try {
    const scenarios = [
      async () => ({ ok: false, status: 500, text: async () => 'erreur ' + BADGE + ' ' + APIKEY }),
      async () => ({ ok: true, status: 200, text: async () => 'oups ' + BADGE }),
      async () => { const e = new Error('échec avec ' + BADGE + ' et ' + APIKEY); e.cause = { code: 'ECONNRESET' }; throw e; },
      async () => { throw new Error(BADGE); },
    ];
    for (const fetchImpl of scenarios) {
      mod._reset();
      const r = await mod.sendHeartbeat({ env: envFor('http://x'), fetchImpl });
      assert.equal(r.status, 'error');
    }
    assert.ok(logs.lines.length >= 4);
    assert.ok(noSecret(logs.lines), 'journaux : ' + JSON.stringify(logs.lines));
  } finally { logs.restore(); }
});

// ── 7. version ────────────────────────────────────────────────────────
test('version : valide acceptée, invalide ignorée', async () => {
  const sent = [];
  const fetchImpl = async (url, opt) => { sent.push(JSON.parse(opt.body)); return { ok: true, status: 200, text: async () => 'true' }; };
  const env = envFor('http://x');
  for (const v of ['1.4.2', '3.8.0-beta+7', 'mauvaise version!', 'a'.repeat(41), '']) {
    mod._reset();
    await mod.sendHeartbeat({ env, fetchImpl, version: v });
  }
  assert.equal(sent[0].p_version, '1.4.2');
  assert.equal(sent[1].p_version, '3.8.0-beta+7');
  assert.equal('p_version' in sent[2], false);
  assert.equal('p_version' in sent[3], false);
  assert.equal('p_version' in sent[4], false);
  for (const b of sent) assert.deepEqual(Object.keys(b).filter((k) => k !== 'p_key' && k !== 'p_version'), []);
});

// ── 8. jamais plus d'un envoi par 30 secondes ─────────────────────────
test('limite : un seul envoi par 30 secondes', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, status: 200, text: async () => 'true' }; };
  const env = envFor('http://x');
  assert.equal((await mod.sendHeartbeat({ env, fetchImpl, now: () => 1000 })).status, 'sent');
  assert.equal((await mod.sendHeartbeat({ env, fetchImpl, now: () => 30000 })).status, 'throttled');
  assert.equal(calls, 1);
  assert.equal((await mod.sendHeartbeat({ env, fetchImpl, now: () => 31001 })).status, 'sent');
  assert.equal(calls, 2);
});

// ── 9. la fonction appelée par le planificateur ───────────────────────
function fakeRes() {
  return { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
}
test('planificateur : mot de passe refusé → 401 et rien n\'est envoyé', async () => {
  let calls = 0;
  const h = mod.createHandler({ env: envFor('http://x', { CRON_SECRET: 'mdp' }), jitterMaxMs: 0, fetchImpl: async () => { calls++; return { ok: true, status: 200, text: async () => 'true' }; } });
  for (const headers of [{}, { authorization: 'Bearer faux' }]) {
    const res = fakeRes();
    await h({ headers }, res);
    assert.equal(res.statusCode, 401);
  }
  assert.equal(calls, 0);
});
test('planificateur : bon mot de passe → 200 et signal envoyé', async () => {
  let calls = 0;
  const h = mod.createHandler({ env: envFor('http://x', { CRON_SECRET: 'mdp' }), jitterMaxMs: 0, fetchImpl: async () => { calls++; return { ok: true, status: 200, text: async () => 'true' }; } });
  const res = fakeRes();
  await h({ headers: { authorization: 'Bearer mdp' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).status, 'sent');
  assert.equal(calls, 1);
});
test('planificateur : même si CONTROL est en panne, répond 200 et ne plante pas', async () => {
  const logs = captureLogs();
  try {
    const h = mod.createHandler({ env: envFor('http://x'), jitterMaxMs: 0, fetchImpl: async () => { throw new Error('panne'); } });
    const res = fakeRes();
    await h({ headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'error');
    assert.deepEqual(Object.keys(JSON.parse(res.body)).sort(), ['ok', 'status']);
  } finally { logs.restore(); }
});
test('planificateur : le décalage aléatoire reste dans la limite', async () => {
  const h = mod.createHandler({ env: envFor('http://x'), jitterMaxMs: 60, fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'true' }) });
  const t0 = Date.now();
  await h({ headers: {} }, fakeRes());
  assert.ok(Date.now() - t0 < 400);
});
