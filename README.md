# AKWABA Baoulé Backend

Proxy minimal pour le tuteur IA : **POST `/chat`** appelle l’API **Google Gemini** (Generative Language API).  
Hugging Face et Groq ne sont **pas** utilisés par ce serveur.

## Prérequis

- Node.js 18+
 - `GEMINI_API_KEY` dans `.env` (copier depuis `.env.example`)

```powershell
cd "d:\tp crypto1.2\baoule-backend"
copy .env.example .env
# Éditer .env et coller ta clé Gemini (`GEMINI_API_KEY`)
npm install
npm start
```

## Tester `/chat` (PowerShell)

Un seul terminal doit faire tourner le serveur (`npm start`). Si un ancien processus écoute encore le port 3000 (ancienne version Masakhane/HF), arrête-le d’abord :

```powershell
Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
```

Puis dans un **autre** terminal :

```powershell
$body = @{
  messages = @(@{ role = "user"; content = "Traduis: bonjour en baoulé" })
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post `
  -Uri "http://localhost:3000/chat" `
  -ContentType "application/json" `
  -Body $body
```

Réponse attendue : objet avec `response` (texte du tuteur).

Santé :

```powershell
Invoke-RestMethod http://localhost:3000/health
```

## Problème DNS Windows (Node vs nslookup)

Symptôme : `getaddrinfo ENOTFOUND api-inference.huggingface.co` ou autre domaine, alors que `nslookup … 1.1.1.1` fonctionne.

- **Cause fréquente** : Node utilise un autre résolveur DNS que `nslookup` (interface / DNS de la box `192.168.1.1`).
 - **Pour ce backend** : configure `GEMINI_API_KEY` — `/chat` n’appelle **pas** Hugging Face.
- **Si un autre outil Node doit joindre HF** : dans `.env`, ajoute `DNS_SERVERS=1.1.1.1,1.0.0.1` (voir `server.js`), ou change le DNS IPv4 de l’interface active dans Windows, puis `ipconfig /flushdns`.

Vérifier côté Node :

```powershell
node -e "require('dns').lookup('generativelanguage.googleapis.com', console.log)"
```

## Déploiement via Docker / Cloud Run

Le backend peut être déployé comme une app Node indépendante.
Un `Dockerfile` et un `.dockerignore` sont fournis dans `baoule-backend/`.

### Exemple Cloud Run

```powershell
cd "d:\tp crypto1.2\baoule-backend"
gcloud config set project suan-16f16
gcloud run deploy akwaba-backend ^
  --source . ^
  --region europe-west1 ^
  --platform managed ^
  --allow-unauthenticated ^
  --set-env-vars GEMINI_API_KEY="TA_CLE_GEMINI",GEMINI_MODEL="models/gemini-flash-latest"
```

Après déploiement, mets l’URL résultante dans `MASAKHANE_BACKEND_URL` du frontend.

## HF_TOKEN encore nécessaire ?

**Non pour ce backend.** `HF_TOKEN` sert à l’app Flutter (`suan`) si elle appelle Hugging Face **directement**. Avec `MASAKHANE_BACKEND_URL=http://localhost:3000`, seule la clé Gemini côté backend suffit.
