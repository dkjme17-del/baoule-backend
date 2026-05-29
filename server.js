const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.warn('⚠️ GEMINI_API_KEY manquant. Le backend démarre, mais /chat ne fonctionnera pas.');
}
else {
  console.log('Provider: Gemini (using GEMINI_API_KEY)');
}

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

app.post('/chat', async (req, res) => {
  try {
    const { messages, context } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Messages invalides" });
    }

    if (!GEMINI_API_KEY) {
      return res.status(503).json({ error: 'GEMINI_API_KEY non configuré. Ajoute-le dans .env puis redémarre.' });
    }

    const systemPrompt = `Tu es AKWABA, tuteur francophone spécialisé en BAOULÉ.

OBJECTIF: Enseigner le BAOULÉ avec pédagogie et précision.

RÈGLES STRICTES:
1. Écris toujours le BAOULÉ en MAJUSCULES.
2. Réponds en français clair et fournis le BAOULÉ complet.
3. Ne JAMAIS inventer ou deviner des formes BAOULÉ.
4. Si tu n'es pas certain d'une traduction, réponds uniquement: "Je suis incertain"
5. Pour une traduction, détaille d'abord chaque mot français, puis donne la phrase BAOULÉ complète.
6. Limite la réponse à 200 mots.
7. Si tu corriges une phrase, indique la correction suivie d'une explication courte.

FORMAT OBLIGATOIRE:
Requête: <texte de l'apprenant>
Français: <texte en français>
BAOULÉ LITTÉRAL: <mot1 FR → mot1 BAOULÉ ; mot2 FR → mot2 BAOULÉ ; ...>
BAOULÉ NATUREL: <phrase BAOULÉ complète en MAJUSCULES>
Explication: <explication courte en français>

CONTEXTE: Enseignement du BAOULÉ pour apprenants francophones

${context ? `SCÉNARIO: ${context}` : ''}`;

  // Few-shot example format to enforce the required structure
  const fewShot = `

EXEMPLE DE FORMAT STRICT:

Requête: "Bonjour"
Français: Bonjour
BAOULÉ LITTÉRAL: Bonjour → [mot baoulé littéral]
BAOULÉ NATUREL: [phrase baoulé complète]
Explication: [courte explication en français]

Requête: "Merci"
Français: Merci
BAOULÉ LITTÉRAL: Merci → [mot baoulé littéral]
BAOULÉ NATUREL: [phrase baoulé complète]
Explication: [courte explication en français]

FIN_EXEMPLES
`;

  // Prepend few-shot examples to system prompt to bias responses
  const effectiveSystemPrompt = fewShot + "\n" + systemPrompt;

    // Conversion messages au format Gemini
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
    // If model name contains 'gemini' prefer the generateContent API, otherwise use generateText
    const supportsGenerateContent = GEMINI_MODEL.toLowerCase().includes('gemini');
    const methodName = supportsGenerateContent ? 'generateContent' : 'generateText';
    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:${methodName}?key=${GEMINI_API_KEY}`;

    let response;
    console.log('Calling Gemini:', GEMINI_URL);
    try {
      if (supportsGenerateContent) {
        // Build gemini-style body
        response = await fetch(GEMINI_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: effectiveSystemPrompt || systemPrompt }] },
            contents: geminiContents,
            generationConfig: { temperature: 0.0, maxOutputTokens: 1024 }
          }),
          signal: controller.signal,
        });
      } else {
        // Build a plain-text prompt for the generateText endpoint
        const promptParts = [systemPrompt, ''];
        for (const m of messages) {
          promptParts.push(`${m.role.toUpperCase()}: ${m.content}`);
        }
        const promptText = promptParts.join('\n\n');

        response = await fetch(GEMINI_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: { text: (effectiveSystemPrompt || systemPrompt) + '\n\n' + promptText }, temperature: 0.0, maxOutputTokens: 1024 }),
          signal: controller.signal,
        });
      }
    } catch (e) {
      if (e?.name === 'AbortError') {
        console.error('Gemini timeout après', timeoutMs, 'ms');
        return res.status(504).json({ error: `Timeout après ${Math.round(timeoutMs / 1000)}s. Réessaie.` });
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }

    // Some responses may be empty or not valid JSON — read as text first
    const raw = await response.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch (e) {
      data = raw;
    }

    if (!response.ok) {
      // Prefer to log raw body when JSON parsing failed or body is empty
      console.error('Gemini Error status', response.status, 'raw:', raw || JSON.stringify(data));

      // Detect common Anthropic billing error in parsed JSON or raw text
      const anthropicBillingMsg = (typeof data?.error?.message === 'string' && data.error.message.includes('credit balance'))
        || (typeof raw === 'string' && raw.includes('credit balance'));

      if (anthropicBillingMsg) {
        return res.status(402).json({
          error: 'Fonds insufﬁsants sur le compte Anthropic référencé par le appel (crédit insuffisant). Vérifie la facturation ou utilise Gemini.'
        });
      }

      const rawMsg = (typeof raw === 'string' && raw.length) ? raw : null;
      const msg = data?.error?.message ?? rawMsg ?? `Erreur API Gemini (status ${response.status})`;

      return res.status(response.status).json({
        error: msg,
        details: data ?? raw,
      });
    }

    // Support different response shapes (generateText vs generateContent)
    const candidate0 = data?.candidates?.[0] || {};
    const content = (
      candidate0.output ||
      candidate0.content?.[0]?.text ||
      candidate0.content?.parts?.[0]?.text ||
      data?.output?.[0]?.content?.[0]?.text ||
      data?.candidates?.[0]?.output ||
      data?.result ||
      data?.text
    );

    const reply = (typeof content === 'string') ? content.trim() : (JSON.stringify(content) || 'Pas de réponse.');
    res.json({ response: reply });

  } catch (error) {
    console.error("Erreur serveur:", error);
    res.status(500).json({
      error: "Erreur interne",
      details: error?.message ? String(error.message) : String(error),
    });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: "✅ AKWABA Backend ready!",
    model: process.env.GEMINI_MODEL || 'text-bison-001',
    apiKeySet: !!GEMINI_API_KEY,
  });
});

// Debug endpoint: list available Gemini models for the configured API key
app.get('/gemini/models', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY non configuré' });
  try {
    const { default: fetch } = await import('node-fetch');
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    console.error('Erreur list models:', e);
    return res.status(500).json({ error: 'Impossible de lister les modèles', details: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 AKWABA Backend sur port ${PORT}`);
  console.log(`GEMINI_API_KEY: ${GEMINI_API_KEY ? '✅ Configurée' : '❌ Manquante'}`);
});
