const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.warn('⚠️ GEMINI_API_KEY manquant. Le backend démarre, mais /chat ne fonctionnera pas.');
} else {
  console.log('Provider: Gemini (using GEMINI_API_KEY)');
}

// =============================
// DICTIONNAIRE BAOULÉ
// =============================
let dictionary = null;
try {
  const dictPath = path.join(__dirname, 'baoule_dictionary.json');
  dictionary = JSON.parse(fs.readFileSync(dictPath, 'utf8'));
  console.log('📖 Dictionnaire Baoulé chargé ✅');
} catch (e) {
  console.warn('⚠️ Dictionnaire non trouvé — réponses sans ancrage local.');
}

function buildDictionaryContext() {
  if (!dictionary) return '';
  const lines = ['\nDICTIONNAIRE BAOULÉ DE RÉFÉRENCE (formes vérifiées — utilise-les en priorité):'];
  const sections = [
    { key: 'salutations', label: 'Salutations' },
    { key: 'identité', label: 'Identité' },
    { key: 'famille', label: 'Famille' },
    { key: 'chiffres', label: 'Chiffres' },
    { key: 'marché', label: 'Marché' },
    { key: 'couleurs', label: 'Couleurs' },
    { key: 'expressions_courantes', label: 'Expressions courantes' },
  ];
  for (const { key, label } of sections) {
    const entries = dictionary[key];
    if (!entries?.length) continue;
    lines.push(`\n[${label}]`);
    for (const e of entries) {
      lines.push(`  ${e.français} → ${e.baoule} (prononciation: ${e.phonétique})`);
    }
  }
  if (dictionary.proverbes?.length) {
    lines.push('\n[Proverbes]');
    for (const p of dictionary.proverbes) {
      lines.push(`  "${p.baoule}" = ${p.français}`);
    }
  }
  lines.push('\nSi le mot demandé est dans ce dictionnaire, utilise EXACTEMENT la forme indiquée.');
  lines.push('Si le mot n\'est PAS dans ce dictionnaire, écris "Je suis incertain de cette forme".');
  return lines.join('\n');
}

// =============================
// LOGGING
// =============================
app.use((req, _res, next) => {
  const start = Date.now();
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  req.requestId = requestId;
  console.log(`[${requestId}] ${req.method} ${req.path}`);
  _res.on('finish', () => {
    console.log(`[${requestId}] -> ${_res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.options('/chat', cors());

// =============================
// ROUTE CHAT
// =============================
app.post('/chat', async (req, res) => {
  try {
    const { messages, context } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Messages invalides" });
    }

    if (!GEMINI_API_KEY) {
      return res.status(503).json({ error: 'GEMINI_API_KEY non configuré. Ajoute-le dans .env puis redémarre.' });
    }

    const dictContext = buildDictionaryContext();

    const systemPrompt = `Tu es AKWABA, tuteur francophone spécialisé en BAOULÉ.

OBJECTIF: Enseigner le BAOULÉ avec pédagogie et précision.

RÈGLES STRICTES:
1. Écris toujours le BAOULÉ en MAJUSCULES.
2. Réponds en français clair et fournis le BAOULÉ complet.
3. Ne JAMAIS inventer ou deviner des formes BAOULÉ.
4. Si un mot est dans le dictionnaire ci-dessous, utilise EXACTEMENT cette forme.
5. Si tu n'es pas certain d'une traduction, réponds uniquement: "Je suis incertain"
6. Pour une traduction, détaille d'abord chaque mot français, puis donne la phrase BAOULÉ complète.
7. Limite la réponse à 250 mots.
8. Si tu corriges une phrase, indique la correction suivie d'une explication courte.

FORMAT OBLIGATOIRE:
Français: <texte en français>
BAOULÉ LITTÉRAL: <mot1 FR → mot1 BAOULÉ ; mot2 FR → mot2 BAOULÉ ; ...>
BAOULÉ NATUREL: <phrase BAOULÉ complète en MAJUSCULES>
Explication: <explication courte en français>

${dictContext}

${context ? `SCÉNARIO: ${context}` : ''}`;

    const fewShot = `
EXEMPLE DE FORMAT STRICT:

Requête: "Bonjour"
Français: Bonjour (matin)
BAOULÉ LITTÉRAL: Bonjour → I NI SƆGƆ
BAOULÉ NATUREL: I NI SƆGƆ
Explication: Salutation matinale universelle en Baoulé.

Requête: "Merci"
Français: Merci
BAOULÉ LITTÉRAL: Merci → MƐDA ASE
BAOULÉ NATUREL: MƐDA ASE
Explication: Remerciement standard, très utilisé au quotidien.

FIN_EXEMPLES
`;

    const effectiveSystemPrompt = fewShot + "\n" + systemPrompt;

    const geminiContents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const { default: fetch } = await import('node-fetch');

    const controller = new AbortController();
    const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 30000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const GEMINI_MODEL = process.env.GEMINI_MODEL || 'models/gemini-2.5-flash';
    // Resolve model path: accept either 'models/NAME' or 'NAME'
    const modelPath = GEMINI_MODEL.startsWith('models/') ? GEMINI_MODEL : `models/${GEMINI_MODEL}`;
    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${GEMINI_API_KEY}`;

    let response;
    console.log('Calling Gemini:', GEMINI_URL);
    try {
      response = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: effectiveSystemPrompt }] },
          contents: geminiContents,
          generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
        }),
        signal: controller.signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError') {
        console.error('Gemini timeout après', timeoutMs, 'ms');
        return res.status(504).json({ error: `Timeout après ${Math.round(timeoutMs / 1000)}s. Réessaie.` });
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }

    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = raw; }

    if (!response.ok) {
      console.error('Gemini Error status', response.status, 'raw:', raw);
      const msg = data?.error?.message ?? raw ?? `Erreur API Gemini (status ${response.status})`;
      return res.status(response.status).json({ error: msg });
    }

    const candidate0 = data?.candidates?.[0] || {};
    const content = (
      candidate0.content?.parts?.[0]?.text ||
      candidate0.content?.[0]?.text ||
      candidate0.output ||
      data?.result ||
      data?.text
    );

    const reply = (typeof content === 'string') ? content.trim() : 'Pas de réponse.';
    res.json({ response: reply });

  } catch (error) {
    console.error("Erreur serveur:", error);
    res.status(500).json({
      error: "Erreur interne",
      details: error?.message ? String(error.message) : String(error),
    });
  }
});

// =============================
// ROUTE DICTIONNAIRE
// =============================
app.get('/dictionary', (req, res) => {
  if (!dictionary) return res.status(404).json({ error: 'Dictionnaire non chargé.' });
  res.json(dictionary);
});

app.get('/dictionary/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q || !dictionary) return res.json({ results: [] });
  const results = [];
  const sections = ['salutations','identité','famille','chiffres','marché','couleurs','expressions_courantes'];
  for (const section of sections) {
    for (const entry of (dictionary[section] || [])) {
      if (entry.français?.toLowerCase().includes(q) || entry.baoule?.toLowerCase().includes(q)) {
        results.push({ ...entry, section });
      }
    }
  }
  res.json({ results });
});

// =============================
// HEALTH
// =============================
app.get('/health', (req, res) => {
  res.json({
    status: "✅ AKWABA Backend ready!",
    model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
    apiKeySet: !!GEMINI_API_KEY,
    dictionaryLoaded: !!dictionary,
    dictionaryEntries: dictionary
      ? Object.values(dictionary).filter(Array.isArray).reduce((acc, arr) => acc + arr.length, 0)
      : 0,
  });
});

app.get('/gemini/models', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY non configuré' });
  try {
    const { default: fetch } = await import('node-fetch');
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: 'Impossible de lister les modèles', details: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 AKWABA Backend sur port ${PORT}`);
  console.log(`GEMINI_API_KEY: ${GEMINI_API_KEY ? '✅ Configurée' : '❌ Manquante'}`);
  console.log(`Dictionnaire: ${dictionary ? '✅ Chargé' : '❌ Non trouvé'}`);
});
