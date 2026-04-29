const express    = require("express");
const cors       = require("cors");
const { google } = require("googleapis");

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
  : ["http://localhost:3000"];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
    else cb(new Error(`CORS bloqueado: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json());

// ─── CREDENCIAIS OAuth ────────────────────────────────────────────────────────
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.REDIRECT_URI || "http://localhost:3747/auth/callback";

// ─── TOKEN STORE EM MEMÓRIA ───────────────────────────────────────────────────
const tokenStore = {
  access_token:  null,
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN || null,
  expiry_date:   null,
};

if (tokenStore.refresh_token) {
  console.log("[GCal] ✔ Token carregado via variável de ambiente");
} else {
  console.log("[GCal] ℹ Sem token — acesse /auth para autenticar");
}

// ─── OAUTH2 CLIENT ────────────────────────────────────────────────────────────
const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

oAuth2Client.on("tokens", (tokens) => {
  if (tokens.refresh_token) tokenStore.refresh_token = tokens.refresh_token;
  tokenStore.access_token = tokens.access_token;
  tokenStore.expiry_date  = tokens.expiry_date || null;
  console.log("[GCal] ✔ Token renovado automaticamente");
});

function applyTokens() {
  oAuth2Client.setCredentials({
    access_token:  tokenStore.access_token,
    refresh_token: tokenStore.refresh_token,
    expiry_date:   tokenStore.expiry_date,
  });
}

async function getAuthClient() {
  if (!tokenStore.refresh_token) {
    const err = new Error("Sem token — acesse /auth");
    err.precisaRelogin = true;
    throw err;
  }

  applyTokens();

  const expirando = !tokenStore.access_token ||
    (tokenStore.expiry_date && Date.now() >= tokenStore.expiry_date - 60000);

  if (expirando) {
    try {
      const { credentials } = await oAuth2Client.refreshAccessToken();
      tokenStore.access_token = credentials.access_token;
      tokenStore.expiry_date  = credentials.expiry_date || null;
      if (credentials.refresh_token) tokenStore.refresh_token = credentials.refresh_token;
      applyTokens();
      console.log("[GCal] ✔ access_token renovado");
    } catch (e) {
      tokenStore.access_token  = null;
      tokenStore.refresh_token = null;
      tokenStore.expiry_date   = null;
      const err = new Error("Token inválido — faça login via /auth");
      err.precisaRelogin = true;
      throw err;
    }
  }

  return oAuth2Client;
}

// ─── LOGIN SIMPLES (sem sessão, sem JWT) ──────────────────────────────────────
// Apenas valida credenciais e retorna ok:true. O frontend controla o estado.
const LOGIN_EMAIL = process.env.LOGIN_EMAIL || "rmcontabilizando@gmail.com";
const LOGIN_SENHA = process.env.LOGIN_SENHA || "sistema01";

app.post("/login", (req, res) => {
  const { email, senha } = req.body;
  if (email === LOGIN_EMAIL && senha === LOGIN_SENHA) {
    console.log("[Auth] ✔ Login bem-sucedido:", email);
    return res.json({ ok: true });
  }
  console.warn("[Auth] ✗ Login inválido para:", email);
  return res.status(401).json({ erro: "Credenciais inválidas" });
});

// ─── STATUS GCAL ──────────────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  const conectado = !!tokenStore.refresh_token;
  res.json({
    conectado,
    email: conectado ? LOGIN_EMAIL : null,
  });
});

// ─── AUTH GOOGLE ──────────────────────────────────────────────────────────────
const usedCodes = new Set();

app.get("/auth", (req, res) => {
  const url = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt:      "consent",
    scope:       ["https://www.googleapis.com/auth/calendar"],
  });
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send(`<script>alert("Código ausente.");window.close();</script>`);
  if (usedCodes.has(code)) {
    console.warn("[GCal] ⚠ Code OAuth duplicado — ignorado");
    return res.send(`<h2 style="font-family:sans-serif;color:green">✓ Já autenticado!</h2><script>setTimeout(()=>window.close(),1000);</script>`);
  }
  usedCodes.add(code);
  setTimeout(() => usedCodes.delete(code), 5 * 60 * 1000);

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    if (tokens.refresh_token) {
      tokenStore.refresh_token = tokens.refresh_token;
      console.log("[GCal] ✔ Novo refresh_token salvo em memória");
      console.log("[GCal] → Copie para GOOGLE_REFRESH_TOKEN:", tokens.refresh_token);
    }
    tokenStore.access_token = tokens.access_token;
    tokenStore.expiry_date  = tokens.expiry_date || null;
    applyTokens();
    console.log("[GCal] ✔ Autenticado com sucesso");

    res.send(`
      <h2 style="font-family:sans-serif;color:green">✓ Autenticado!</h2>
      <p style="font-family:sans-serif">Pode fechar esta janela.</p>
      <script>
        if (window.opener) {
          window.opener.postMessage({ type: "google-auth-success" }, "*");
          setTimeout(() => window.close(), 1500);
        }
      </script>
    `);
  } catch (e) {
    usedCodes.delete(code);
    console.error("[GCal] ✗ ERRO NO CALLBACK:", e.message);
    res.send(`<script>alert("Erro: ${e.message}");window.close();</script>`);
  }
});

app.post("/auth/logout", (req, res) => res.json({ ok: true }));

// ─── CRIAR / ATUALIZAR EVENTO ─────────────────────────────────────────────────
app.post("/criar-evento", async (req, res) => {
  try {
    const { summary, description, start, eventId, calendarId } = req.body;
    const rawDate = start?.dateTime || req.body.date || null;
    if (!rawDate) return res.status(400).json({ erro: "start.dateTime obrigatório" });

    const normalizeDate = (d) =>
      typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)
        ? `${d}T10:00:00-03:00` : d;

    const startDate = normalizeDate(rawDate);
    const endDate   = new Date(new Date(startDate).getTime() + 60 * 60 * 1000).toISOString();

    const auth      = await getAuthClient();
    const calendar  = google.calendar({ version: "v3", auth });
    const targetCal = calendarId || "primary";
    const eventBody = {
      summary, description,
      start: { dateTime: startDate, timeZone: "America/Sao_Paulo" },
      end:   { dateTime: endDate,   timeZone: "America/Sao_Paulo" },
    };

    let response;
    if (eventId) {
      response = await calendar.events.update({ calendarId: targetCal, eventId, requestBody: eventBody });
      console.log("[GCal] ✔ Evento atualizado:", response.data.id);
      return res.json({ ok: true, id: response.data.id, atualizado: true });
    } else {
      response = await calendar.events.insert({ calendarId: targetCal, requestBody: eventBody });
      console.log("[GCal] ✔ Evento criado:", response.data.id);
      return res.json({ ok: true, id: response.data.id, criado: true });
    }
  } catch (e) {
    const msg = e?.response?.data?.error?.message || e.message;
    console.error("[GCal] ✗ /criar-evento:", msg);
    return res.status(500).json({ erro: "Falha ao criar evento", detalhe: msg, precisaRelogin: !!e.precisaRelogin });
  }
});

// ─── DELETAR EVENTO ───────────────────────────────────────────────────────────
app.post("/deletar-evento", async (req, res) => {
  try {
    const { eventId } = req.body;
    if (!eventId) return res.status(400).json({ erro: "eventId obrigatório" });
    const auth     = await getAuthClient();
    const calendar = google.calendar({ version: "v3", auth });
    await calendar.events.delete({ calendarId: "primary", eventId });
    console.log("[GCal] ✔ Evento deletado:", eventId);
    return res.json({ ok: true });
  } catch (e) {
    console.error("[GCal] ✗ /deletar-evento:", e.message);
    return res.status(500).json({ erro: "Falha ao deletar evento", detalhe: e.message });
  }
});

// ─── LISTAR CALENDÁRIOS ───────────────────────────────────────────────────────
app.get("/calendars", async (req, res) => {
  try {
    const auth     = await getAuthClient();
    const calendar = google.calendar({ version: "v3", auth });
    const r        = await calendar.calendarList.list();
    return res.json({ calendars: r.data.items || [] });
  } catch (e) {
    console.error("[GCal] ✗ /calendars:", e.message);
    return res.status(500).json({ erro: "Falha ao listar calendários" });
  }
});

// ─── DATAJUD — proxy CNJ ──────────────────────────────────────────────────────
app.get("/datajud/:tribunal/:numero", async (req, res) => {
  const { tribunal, numero } = req.params;
  const ALIASES = {
    TJRN:"tjrn",TJPB:"tjpb",TJMG:"tjmg",TJSP:"tjsp",TJPR:"tjpr",
    TJAC:"tjac",TJAL:"tjal",TJAP:"tjap",TJAM:"tjam",TJBA:"tjba",
    TJCE:"tjce",TJDFT:"tjdft",TJES:"tjes",TJGO:"tjgo",TJMA:"tjma",
    TJMT:"tjmt",TJMS:"tjms",TJPA:"tjpa",TJPE:"tjpe",TJPI:"tjpi",
    TJRJ:"tjrj",TJRS:"tjrs",TJRO:"tjro",TJRR:"tjrr",TJSC:"tjsc",
    TJSE:"tjse",TJTO:"tjto",TRT21:"trt21",TRF5:"trf5",
  };
  const alias = ALIASES[tribunal?.toUpperCase()] || "tjrn";
  try {
    const response = await fetch(
      `https://api-publica.datajud.cnj.jus.br/api_publica_${alias}/_search`,
      { method:"POST", headers:{"Content-Type":"application/json","Authorization":"ApiKey cDZHYzlZa0JadVREZDJCendFbXNpMTc6iFUyOThiRWVSRW5WZlZGd2h3ZVdfdw=="},
        body: JSON.stringify({ query: { match: { numeroProcesso: numero } } }) }
    );
    if (!response.ok) return res.status(response.status).json({ erro: "Erro no DataJud" });
    const data = await response.json();
    const hit  = data?.hits?.hits?.[0]?._source;
    if (!hit) return res.json({ encontrado: false });
    const movs   = (hit.movimentos||[]).sort((a,b)=>new Date(b.dataHora)-new Date(a.dataHora));
    const partes = hit.partes||[];
    return res.json({
      encontrado:    true,
      autor:         partes.filter(p=>p.polo==="AT").map(p=>p.nome).join(", "),
      reu:           partes.filter(p=>p.polo==="PA").map(p=>p.nome).join(", "),
      vara:          hit.orgaoJulgador?.nome||"",
      ultima_mov:    movs[0]?`${movs[0].nome} (${movs[0].dataHora?.slice(0,10)})`:"",
      total_movs:    movs.length,
      total_partes:  partes.length,
    });
  } catch (e) {
    console.error("[DataJud] ✗", e.message);
    return res.status(500).json({ erro: "Falha ao consultar DataJud" });
  }
});

// ─── ESCAVADOR ────────────────────────────────────────────────────────────────
app.get("/processo/:numero", async (req, res) => {
  const apiKey = process.env.ESCAVADOR_API_KEY;
  if (!apiKey) return res.status(500).json({ erro: "ESCAVADOR_API_KEY não configurada" });
  try {
    const response = await fetch(
      `https://api.escavador.com/api/v1/processos/numero_cnj/${encodeURIComponent(req.params.numero.trim())}`,
      { headers: { "Authorization":`Bearer ${apiKey}`, "Content-Type":"application/json" } }
    );
    if (!response.ok) return res.status(response.status).json({ erro: "Erro no Escavador" });
    const data     = await response.json();
    const processo = Array.isArray(data?.items) ? data.items[0] : data;
    if (!processo) return res.json({ encontrado: false });
    const partes   = processo.envolvidos||processo.partes||[];
    const autores  = partes.filter(p=>/ativo|autor|requerente/i.test(p.polo||""));
    const reus     = partes.filter(p=>/passivo|réu|requerido/i.test(p.polo||""));
    return res.json({
      encontrado: true,
      numero:    processo.numero_cnj||req.params.numero,
      tribunal:  processo.tribunal?.sigla||"",
      classe:    processo.classe?.nome||"",
      autor:     autores[0]?.nome||"",
      reu:       reus[0]?.nome||"",
    });
  } catch (e) {
    console.error("[Escavador] ✗", e.message);
    return res.status(500).json({ erro: "Erro ao consultar processo" });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3747;
app.listen(PORT, () => {
  console.log(`[Server] ✔ Rodando na porta ${PORT}`);
  console.log(`[Server] ✔ Origens permitidas: ${ALLOWED_ORIGINS.join(", ")}`);
});