const express    = require("express");
const session    = require("express-session");
const cors       = require("cors");
const { google } = require("googleapis");

const app = express();

// ─── CORS DINÂMICO ────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
  : ["http://localhost:3000"];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
    else cb(new Error(`CORS bloqueado para origem: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json());
// Em produção (HTTPS cross-origin Vercel→Render) cookies precisam de
// secure:true e sameSite:"none". Em dev local usa sameSite:"lax".
const isProd = process.env.NODE_ENV === "production";
app.set("trust proxy", 1); // necessário atrás do proxy do Render

app.use(session({
  secret: process.env.SESSION_SECRET || "segredo",
  resave: true,
  saveUninitialized: false,
  cookie: {
    secure:   isProd,          // true em produção (HTTPS obrigatório)
    sameSite: isProd ? "none" : "lax", // "none" permite cross-origin
    httpOnly: true,
    maxAge:   24 * 60 * 60 * 1000,    // 24h
  }
}));

// ─── CREDENCIAIS OAuth ────────────────────────────────────────────────────────
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.REDIRECT_URI || "http://localhost:3747/auth/callback";

// ─── TOKEN STORE EM MEMÓRIA ───────────────────────────────────────────────────
// refresh_token pode ser pré-carregado via variável de ambiente GOOGLE_REFRESH_TOKEN.
// Isso garante que após restarts no Render o token não se perde.
// Para obter o valor: autentique via /auth uma vez localmente e copie o refresh_token dos logs.
const tokenStore = {
  access_token:  null,
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN || null,
  expiry_date:   null,
};

if (tokenStore.refresh_token) {
  console.log("[GCal] ✔ Token carregado em memória via variável de ambiente");
} else {
  console.log("[GCal] ℹ Nenhum token encontrado — acesse /auth para autenticar");
}

// ─── INSTÂNCIA ÚNICA do OAuth2 ────────────────────────────────────────────────
const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// Listener de renovação automática
oAuth2Client.on("tokens", (tokens) => {
  console.log("[GCal] ♻ Token renovado automaticamente pelo listener");
  if (tokens.refresh_token) {
    tokenStore.refresh_token = tokens.refresh_token;
    console.log("[GCal] ✔ Novo refresh_token salvo em memória");
  }
  tokenStore.access_token = tokens.access_token;
  tokenStore.expiry_date  = tokens.expiry_date || null;
  console.log("[GCal] ✔ Token atualizado em memória");
});

function applyTokens() {
  oAuth2Client.setCredentials({
    access_token:  tokenStore.access_token,
    refresh_token: tokenStore.refresh_token,
    expiry_date:   tokenStore.expiry_date,
  });
}

// ─── HELPER — cliente autenticado com renovação automática ────────────────────
async function getAuthClient() {
  if (!tokenStore.refresh_token) {
    const err = new Error("Sem refresh_token — faça login via /auth");
    err.precisaRelogin = true;
    throw err;
  }

  applyTokens();

  const expirando = !tokenStore.access_token ||
    (tokenStore.expiry_date && Date.now() >= tokenStore.expiry_date - 60000);

  if (expirando) {
    console.log("[GCal] access_token expirado/ausente — renovando via refresh_token…");
    try {
      const { credentials } = await oAuth2Client.refreshAccessToken();
      tokenStore.access_token = credentials.access_token;
      tokenStore.expiry_date  = credentials.expiry_date || null;
      if (credentials.refresh_token) tokenStore.refresh_token = credentials.refresh_token;
      applyTokens();
      console.log("[GCal] ✔ access_token renovado e salvo em memória");
    } catch (e) {
      console.error("[GCal] ✗ Falha ao renovar token:", e.message);
      tokenStore.access_token  = null;
      tokenStore.refresh_token = null;
      tokenStore.expiry_date   = null;
      const err = new Error("refresh_token inválido — faça login novamente via /auth");
      err.precisaRelogin = true;
      throw err;
    }
  }

  return oAuth2Client;
}

// ─── LOGIN DO SISTEMA ─────────────────────────────────────────────────────────
const LOGIN_EMAIL = process.env.LOGIN_EMAIL || "rmcontabilizando@gmail.com";
const LOGIN_SENHA = process.env.LOGIN_SENHA || "sistema01";

app.post("/login", (req, res) => {
  const { email, senha } = req.body;
  if (email === LOGIN_EMAIL && senha === LOGIN_SENHA) {
    req.session.user = { logado: true };
    console.log("[Auth] ✔ Login realizado");
    return res.json({ ok: true });
  }
  console.warn("[Auth] ✗ Tentativa de login inválida");
  return res.status(401).json({ erro: "Email ou senha incorretos" });
});

// ─── VERIFICAR SESSÃO ─────────────────────────────────────────────────────────
app.get("/me", (req, res) => {
  res.json({ logado: !!req.session.user?.logado });
});

// ─── LOGOUT DO SISTEMA ────────────────────────────────────────────────────────
app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    console.log("[Auth] ✔ Sessão encerrada");
    res.json({ ok: true });
  });
});

// ─── STATUS GCAL ─────────────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  const conectado = !!tokenStore.refresh_token;
  res.json({
    conectado,
    logado: conectado,
    email:  req.session.email || (conectado ? LOGIN_EMAIL : null),
  });
});

// ─── AUTH GOOGLE ──────────────────────────────────────────────────────────────
app.get("/auth", (req, res) => {
  const url = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt:      "consent",
    scope:       ["https://www.googleapis.com/auth/calendar"],
  });
  res.redirect(url);
});

// Guard contra uso duplo do mesmo code OAuth
const usedCodes = new Set();

app.get("/auth/callback", async (req, res) => {
  const code = req.query.code;

  // Rejeita imediatamente se o code já foi processado
  if (!code) {
    return res.send(`<script>alert("Código OAuth ausente.");window.close();</script>`);
  }
  if (usedCodes.has(code)) {
    console.warn("[GCal] ⚠ Code OAuth já utilizado — ignorando requisição duplicada");
    return res.send(`
      <h2 style="font-family:sans-serif;color:green">✓ Já autenticado!</h2>
      <p style="font-family:sans-serif">Pode fechar esta janela.</p>
      <script>setTimeout(()=>window.close(),1000);</script>
    `);
  }
  usedCodes.add(code);
  // Limpa codes antigos após 5 min para não acumular memória
  setTimeout(() => usedCodes.delete(code), 5 * 60 * 1000);

  try {
    const { tokens } = await oAuth2Client.getToken(code);

    if (tokens.refresh_token) {
      tokenStore.refresh_token = tokens.refresh_token;
      console.log("[GCal] ✔ Novo refresh_token salvo em memória");
    } else {
      console.warn("[GCal] ⚠ refresh_token NÃO retornado — usando anterior:", tokenStore.refresh_token ? "existe" : "AUSENTE");
    }

    tokenStore.access_token = tokens.access_token;
    tokenStore.expiry_date  = tokens.expiry_date || null;
    applyTokens();

    req.session.email = LOGIN_EMAIL;
    console.log("[GCal] ✔ Usuário autenticado — tokens carregados em memória");

    req.session.save(() => {
      res.send(`
        <h2 style="font-family:sans-serif;color:green">✓ Autenticado com sucesso!</h2>
        <p style="font-family:sans-serif">Pode fechar esta janela.</p>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: "google-auth-success" }, "*");
            setTimeout(() => window.close(), 1500);
          }
        </script>
      `);
    });
  } catch (error) {
    // Remove o code do set para permitir nova tentativa em caso de erro real
    usedCodes.delete(code);
    console.error("[GCal] ✗ ERRO NO CALLBACK:", error.message);
    res.send(`<script>alert("Erro ao autenticar: ${error.message}");window.close();</script>`);
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.tokens = null;
  res.json({ ok: true });
});

// ─── CRIAR / ATUALIZAR EVENTO ─────────────────────────────────────────────────
app.post("/criar-evento", async (req, res) => {
  console.log("[GCal] CHAMOU /criar-evento");

  try {
    const { summary, description, start, eventId, calendarId } = req.body;

    const rawDate = start?.dateTime || req.body.date || null;
    if (!rawDate) return res.status(400).json({ erro: "start.dateTime obrigatório" });

    const normalizeDate = (d) =>
      typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)
        ? `${d}T10:00:00-03:00`
        : d;

    const startDate = normalizeDate(rawDate);
    const endDate   = new Date(new Date(startDate).getTime() + 60 * 60 * 1000).toISOString();

    console.log("[GCal] START:", startDate);
    console.log("[GCal] END:",   endDate);

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
      console.log("[GCal] ✔ EVENTO ATUALIZADO:", response.data.id);
      return res.json({ ok: true, id: response.data.id, atualizado: true });
    } else {
      response = await calendar.events.insert({ calendarId: targetCal, requestBody: eventBody });
      console.log("[GCal] ✔ EVENTO CRIADO:", response.data.id);
      return res.json({ ok: true, id: response.data.id, criado: true });
    }

  } catch (error) {
    const msg            = error?.response?.data?.error?.message || error.message;
    const precisaRelogin = !!error.precisaRelogin || msg?.includes("invalid_grant");
    console.error("[GCal] ✗ ERRO /criar-evento:", msg);
    return res.status(500).json({ erro: "Falha ao criar evento", detalhe: msg, precisaRelogin });
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
    return res.json({ ok: true });
  } catch (error) {
    console.error("[GCal] ✗ ERRO /deletar-evento:", error.message);
    return res.status(500).json({ erro: "Falha ao deletar evento", detalhe: error.message });
  }
});

// ─── LISTAR CALENDÁRIOS ───────────────────────────────────────────────────────
app.get("/calendars", async (req, res) => {
  try {
    const auth     = await getAuthClient();
    const calendar = google.calendar({ version: "v3", auth });
    const r        = await calendar.calendarList.list();
    return res.json({ calendars: r.data.items || [] });
  } catch (error) {
    console.error("[GCal] ✗ ERRO /calendars:", error.message);
    return res.status(500).json({ erro: "Falha ao listar calendários" });
  }
});

// ─── DATAJUD — proxy para API pública do CNJ ─────────────────────────────────
// Evita erro de CORS no frontend consultando diretamente do backend
app.get("/datajud/:tribunal/:numero", async (req, res) => {
  const { tribunal, numero } = req.params;

  const ALIASES = {
    TJRN:"tjrn", TJPB:"tjpb", TJMG:"tjmg", TJSP:"tjsp", TJPR:"tjpr",
    TJAC:"tjac", TJAL:"tjal", TJAP:"tjap", TJAM:"tjam", TJBA:"tjba",
    TJCE:"tjce", TJDFT:"tjdft", TJES:"tjes", TJGO:"tjgo", TJMA:"tjma",
    TJMT:"tjmt", TJMS:"tjms", TJPA:"tjpa", TJPE:"tjpe", TJPI:"tjpi",
    TJRJ:"tjrj", TJRS:"tjrs", TJRO:"tjro", TJRR:"tjrr", TJSC:"tjsc",
    TJSE:"tjse", TJTO:"tjto", TRT21:"trt21", TRF5:"trf5",
  };

  const alias = ALIASES[tribunal?.toUpperCase()] || "tjrn";
  const url   = `https://api-publica.datajud.cnj.jus.br/api_publica_${alias}/_search`;

  try {
    const response = await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": "ApiKey cDZHYzlZa0JadVREZDJCendFbXNpMTc6iFUyOThiRWVSRW5WZlZGd2h3ZVdfdw==",
      },
      body: JSON.stringify({
        query: { match: { numeroProcesso: numero } },
      }),
    });

    if (!response.ok) {
      const txt = await response.text();
      console.error("[DataJud] Erro HTTP:", response.status, txt);
      return res.status(response.status).json({ erro: "Erro na API do DataJud", detalhe: txt });
    }

    const data = await response.json();
    const hit  = data?.hits?.hits?.[0]?._source;

    if (!hit) {
      return res.json({ encontrado: false });
    }

    const movs  = (hit.movimentos || []).sort((a,b) => new Date(b.dataHora) - new Date(a.dataHora));
    const partes = hit.partes || [];
    const autor  = partes.filter(p => p.polo === "AT").map(p => p.nome).join(", ");
    const reu    = partes.filter(p => p.polo === "PA").map(p => p.nome).join(", ");

    console.log(`[DataJud] ✔ Processo encontrado: ${numero}`);
    return res.json({
      encontrado:  true,
      autor,
      reu,
      vara:        hit.orgaoJulgador?.nome || "",
      ultima_mov:  movs[0] ? `${movs[0].nome} (${movs[0].dataHora?.slice(0,10)})` : "",
      total_movs:  movs.length,
      total_partes: partes.length,
    });

  } catch (e) {
    console.error("[DataJud] ✗ Erro:", e.message);
    return res.status(500).json({ erro: "Falha ao consultar DataJud", detalhe: e.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3747;
app.listen(PORT, () => {
  console.log(`[GCal] Servidor rodando na porta ${PORT}`);
  console.log("[GCal] ℹ Tokens em memória — autentique via /auth após cada restart");
});