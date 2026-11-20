// Vercel-Funktion: übersetzt eine Anweisung in Worten ("Am Wochenende nichts lernen") in konkrete Plan-Änderungen.
// Die Schlüssel stehen NUR hier auf dem Server (Vercel → Settings → Environment Variables), niemals im Code der App.
//   GEMINI_API_KEY     – Google AI Studio, hat einen kostenlosen Tarif (Standardmodell: gemini-2.5-flash, änderbar mit GEMINI_MODEL)
//   ANTHROPIC_API_KEY  – optional, kostenpflichtig (Standardmodell: claude-sonnet-5-5, änderbar mit ANTHROPIC_MODEL)
// Ist beides gesetzt, wird Gemini bevorzugt (kostenlos), außer PLAN_KI=claude.

const SYSTEM = `Du bist der Planungs-Assistent einer Lernplan-App. Der Nutzer beschreibt in Worten, wie sein Lernplan geändert werden soll.
Du änderst den Plan ausschließlich über das Werkzeug "plan_aendern".

Regeln:
- Datumsformat immer YYYY-MM-DD. Nutze die mitgelieferte Tabelle mit Wochentagen, rechne Wochentage nicht selbst aus.
- "lernfrei_setzen": Tage, an denen nichts gelernt wird. Die App verteilt die Themen danach selbst neu, du musst Themen von lernfreien Tagen NICHT einzeln verschieben. Nur Tage ab heute und vor der letzten Prüfung.
- "thema_verschieben": nur für Themen aus der Planliste (Schlüssel exakt übernehmen). Das Ziel muss ab heute und VOR der Prüfung des Fachs liegen und darf kein lernfreier Tag sein.
- "fach_aendern": Prüfungsdatum, Anzahl Wiederholungen (0-5) oder Lernverlauf (flat = gleichmäßig, rising = steigend, strong = stark steigend) eines Fachs, mit der Fach-ID aus der Liste.
- "verschiebung_aufheben": mit dem Schlüssel eines Themas oder "alle".
- Mach nur das, was der Nutzer verlangt, so wenig Änderungen wie möglich.
- Ist die Anweisung unklar oder nicht umsetzbar, stelle in "rueckfrage" eine kurze Frage und lasse "operationen" leer.
- Hat der Nutzer einen früheren Vorschlag korrigiert (siehe "verlauf"), erstelle einen NEUEN, vollständigen Vorschlag, der die Korrektur berücksichtigt.
- "zusammenfassung": 1-3 kurze Sätze auf Deutsch in Du-Form, was du vorschlägst.`;

const PROPS = {
  zusammenfassung: { type: 'string', description: 'Kurze Erklärung auf Deutsch (Du-Form).' },
  rueckfrage: { type: 'string', description: 'Nur wenn die Anweisung unklar ist; dann bleibt operationen leer.' },
  operationen: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        typ: { type: 'string', enum: ['lernfrei_setzen', 'lernfrei_aufheben', 'thema_verschieben', 'verschiebung_aufheben', 'fach_aendern'] },
        daten: { type: 'array', items: { type: 'string' }, description: 'Tage (YYYY-MM-DD) für lernfrei_setzen / lernfrei_aufheben.' },
        schluessel: { type: 'string', description: 'Themen-Schlüssel (thema_verschieben, verschiebung_aufheben; bei letzterem auch "alle").' },
        ziel: { type: 'string', description: 'Zieltag YYYY-MM-DD für thema_verschieben.' },
        fach_id: { type: 'string' },
        pruefungsdatum: { type: 'string' },
        wiederholungen: { type: 'integer' },
        lernverlauf: { type: 'string', enum: ['flat', 'rising', 'strong'] }
      },
      required: ['typ']
    }
  }
};
const PARAMS = { type: 'object', properties: PROPS, required: ['zusammenfassung', 'operationen'] };
const TOOL_NAME = 'plan_aendern';
const TOOL_DESC = 'Schlägt Änderungen am Lernplan vor.';

const hits = new Map();   // einfache Bremse pro IP (pro Serverinstanz)
function tooMany(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  list.push(now); hits.set(ip, list);
  return list.length > 40;
}

const send = (res, code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };

async function viaGemini(key, text) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      tools: [{ functionDeclarations: [{ name: TOOL_NAME, description: TOOL_DESC, parameters: PARAMS }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [TOOL_NAME] } },
      generationConfig: { temperature: 0.2, maxOutputTokens: 4000 }
    })
  });
  if (!r.ok) return { fehler: r.status === 429 ? 'zu_viele_anfragen' : 'ki_fehler', status: r.status };
  const j = await r.json();
  const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  const call = parts.find(p => p.functionCall && p.functionCall.args);
  return call ? { input: call.functionCall.args } : { fehler: 'ki_ohne_antwort' };
}

async function viaClaude(key, text) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 4000, system: SYSTEM,
      tools: [{ name: TOOL_NAME, description: TOOL_DESC, input_schema: PARAMS }],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [{ role: 'user', content: text }]
    })
  });
  if (!r.ok) return { fehler: r.status === 429 ? 'zu_viele_anfragen' : 'ki_fehler', status: r.status };
  const j = await r.json();
  const tu = (j.content || []).find(c => c.type === 'tool_use');
  return tu && tu.input ? { input: tu.input } : { fehler: 'ki_ohne_antwort' };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { fehler: 'nur_post' });
  const gKey = process.env.GEMINI_API_KEY, aKey = process.env.ANTHROPIC_API_KEY;
  if (!gKey && !aKey) return send(res, 503, { fehler: 'ki_nicht_eingerichtet' });

  const b = req.body || {};
  const anweisung = String(b.anweisung || '').trim().slice(0, 600);
  if (!anweisung) return send(res, 400, { fehler: 'keine_anweisung' });
  if (JSON.stringify(b).length > 150000) return send(res, 413, { fehler: 'zu_gross' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unbekannt';
  if (tooMany(ip)) return send(res, 429, { fehler: 'zu_viele_anfragen' });

  const heute = String(b.heute || '').slice(0, 10);
  const wochentage = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const tage = [];
  const start = /^\d{4}-\d{2}-\d{2}$/.test(heute) ? new Date(heute + 'T12:00:00Z') : new Date();
  for (let i = 0; i < 28; i++) { const d = new Date(start.getTime() + i * 864e5); tage.push(`${d.toISOString().slice(0, 10)} ${wochentage[d.getUTCDay()]}`); }

  const verlauf = Array.isArray(b.verlauf) ? b.verlauf.slice(-4).map(v => `- Anweisung: ${String(v.anweisung || '').slice(0, 400)}\n  Mein Vorschlag war: ${String(v.zusammenfassung || '').slice(0, 400)}`).join('\n') : '';
  const text = [
    `Heute ist ${tage[0]}.`,
    `Kommende Tage:\n${tage.join('\n')}`,
    `Fächer (JSON):\n${JSON.stringify(b.faecher || [])}`,
    `Lernfreie Tage: ${JSON.stringify(b.lernfrei || [])}`,
    `Aktueller Plan (Zeilen: Tag|Schlüssel|Fach|Thema|L=Lernen / W1..=Wiederholung):\n${(Array.isArray(b.plan) ? b.plan : []).slice(0, 500).join('\n')}`,
    verlauf ? `Bisheriger Verlauf (der Nutzer war damit nicht zufrieden oder hat korrigiert):\n${verlauf}` : '',
    `Neue Anweisung des Nutzers: ${anweisung}`
  ].filter(Boolean).join('\n\n');

  try {
    const useClaude = aKey && (!gKey || process.env.PLAN_KI === 'claude');
    const out = useClaude ? await viaClaude(aKey, text) : await viaGemini(gKey, text);
    if (out.fehler) return send(res, out.fehler === 'zu_viele_anfragen' ? 429 : 502, out);
    const o = out.input || {};
    send(res, 200, {
      zusammenfassung: String(o.zusammenfassung || ''),
      rueckfrage: String(o.rueckfrage || ''),
      operationen: Array.isArray(o.operationen) ? o.operationen.slice(0, 200) : []
    });
  } catch (e) {
    send(res, 502, { fehler: 'ki_nicht_erreichbar' });
  }
};
