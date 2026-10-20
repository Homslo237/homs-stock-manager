'use strict';
/**
 * LIAISON HOMSLO CONTROL — signal de vie (heartbeat)
 * ---------------------------------------------------
 * Ce fichier est le SEUL fichier de la liaison. Pour la retirer : supprimer ce
 * fichier (et le planificateur qui l'appelle). Rien d'autre dans le SaaS n'en dépend.
 *
 * Ce que le fichier envoie à CONTROL : { p_key: <badge>, p_version: <version> }.
 * RIEN d'autre : ni clients, ni données, ni prix, ni mots de passe.
 *
 * Il tourne sur le SERVEUR (fonction Vercel), jamais dans le navigateur :
 * le badge n'est donc jamais visible par les clients.
 *
 * Variables d'environnement (secrètes, voir .env.example) :
 *   HOMSLO_CONTROL_URL     adresse complète de la fonction saas_heartbeat
 *   HOMSLO_CONTROL_APIKEY  clé publique de CONTROL
 *   HOMSLO_CONTROL_BADGE   badge de ce SaaS (hsk_...)
 * Facultative mais recommandée :
 *   CRON_SECRET            mot de passe que le planificateur doit présenter
 */

// ⚙️ Version du SaaS envoyée à CONTROL : à changer ICI à chaque nouvelle version.
const APP_VERSION = '3.8.0';

const TIMEOUT_MS = 5000;        // délai maximum d'un envoi
const MIN_GAP_MS = 30000;       // jamais plus d'un envoi par 30 secondes
const MAX_JITTER_MS = 3000;     // petit décalage aléatoire avant l'envoi
const VERSION_RE = /^[A-Za-z0-9._+-]{1,40}$/;
const REQUIRED = ['HOMSLO_CONTROL_URL', 'HOMSLO_CONTROL_APIKEY', 'HOMSLO_CONTROL_BADGE'];

let lastSentAt = 0;
let warnedDisabled = false;

function readConfig(env) {
  const get = (k) => (env[k] == null ? '' : String(env[k]).trim());
  const missing = REQUIRED.filter((k) => !get(k));
  return {
    ok: missing.length === 0,
    missing,
    url: get('HOMSLO_CONTROL_URL'),
    apikey: get('HOMSLO_CONTROL_APIKEY'),
    badge: get('HOMSLO_CONTROL_BADGE'),
  };
}

// Efface toute valeur secrète d'un texte avant de l'écrire dans les journaux.
function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('***');
  }
  return out;
}

function log(level, message, secrets) {
  try {
    console[level]('[HOMSLO-CONTROL] ' + redact(message, secrets || []));
  } catch (e) { /* un journal ne doit jamais faire planter */ }
}

/**
 * Envoie UN signal de vie. Ne lève JAMAIS d'erreur.
 * Retourne { status: 'sent' | 'refused' | 'error' | 'disabled' | 'throttled' }.
 */
async function sendHeartbeat(opts = {}) {
  const env = opts.env || process.env;
  const cfg = readConfig(env);
  const secrets = [cfg.badge, cfg.apikey];
  try {
    if (!cfg.ok) {
      if (!warnedDisabled) {
        warnedDisabled = true;
        log('warn', 'liaison désactivée : variable(s) manquante(s) : ' + cfg.missing.join(', ') +
          '. Le SaaS fonctionne normalement sans la liaison.', secrets);
      }
      return { status: 'disabled', missing: cfg.missing };
    }

    const now = (opts.now || Date.now)();
    if (lastSentAt && now - lastSentAt < MIN_GAP_MS) return { status: 'throttled' };
    lastSentAt = now;

    const version = opts.version != null ? String(opts.version) : APP_VERSION;
    const body = { p_key: cfg.badge };
    if (VERSION_RE.test(version)) body.p_version = version;

    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res, text;
    try {
      res = await fetchImpl(cfg.url, {
        method: 'POST',
        headers: { apikey: cfg.apikey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      log('warn', 'envoi échoué : réponse HTTP ' + res.status + '. Prochain essai au prochain signal planifié.', secrets);
      return { status: 'error', http: res.status };
    }
    let answer;
    try { answer = JSON.parse(text); } catch (e) { answer = undefined; }
    if (answer === true) return { status: 'sent' };
    if (answer === false) {
      log('warn', 'badge refusé par CONTROL (inconnu ou révoqué). Vérifie HOMSLO_CONTROL_BADGE.', secrets);
      return { status: 'refused' };
    }
    log('warn', 'envoi échoué : réponse inattendue de CONTROL.', secrets);
    return { status: 'error' };
  } catch (err) {
    let why;
    if (err && err.name === 'AbortError') why = 'délai de ' + Math.round((opts.timeoutMs || TIMEOUT_MS) / 1000) + ' s dépassé';
    else why = 'erreur réseau (' + ((err && err.cause && err.cause.code) || (err && err.code) || (err && err.name) || 'inconnue') + ')';
    log('warn', 'envoi échoué : ' + why + '. Prochain essai au prochain signal planifié.', secrets);
    return { status: 'error' };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fonction appelée par le planificateur (toutes les 5 minutes).
 * Répond toujours poliment, sans détail, et ne plante jamais.
 */
function createHandler(options = {}) {
  const env = options.env || process.env;
  const jitterMax = options.jitterMaxMs != null ? options.jitterMaxMs : MAX_JITTER_MS;
  return async function handler(req, res) {
    const reply = (code, obj) => {
      try {
        res.statusCode = code;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(obj));
      } catch (e) { /* rien */ }
    };
    try {
      const secret = env.CRON_SECRET ? String(env.CRON_SECRET) : '';
      if (secret) {
        const auth = (req && req.headers && req.headers.authorization) || '';
        if (auth !== 'Bearer ' + secret) return reply(401, { ok: false });
      }
      if (jitterMax > 0) await sleep(Math.floor(Math.random() * jitterMax));
      const r = await sendHeartbeat({ env, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs, version: options.version });
      return reply(200, { ok: true, status: r.status });
    } catch (e) {
      return reply(200, { ok: true, status: 'error' });
    }
  };
}

const handler = createHandler();
module.exports = handler;
module.exports.handler = handler;
module.exports.createHandler = createHandler;
module.exports.sendHeartbeat = sendHeartbeat;
module.exports.APP_VERSION = APP_VERSION;
module.exports._reset = () => { lastSentAt = 0; warnedDisabled = false; };
