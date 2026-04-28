const express    = require("express");
const session    = require("express-session");
const cors       = require("cors");
const fs         = require("fs");
const path       = require("path");
const { google } = require("googleapis");

const app = express();

// ─── CORS DINÂMICO ────────────────────────────────────────────────────────────
// Em produção: ALLOWED_ORIGINS=https://frontend.com,https://outro.com
// Em dev: permite localhost:3000 automaticamente
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
  : ["http://localhost:3000"];

app.use(cors({
  origin: (origin, cb) => {
    // Permite requests sem origin (ex: Postman, mobile)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
    else cb(new Error(`CORS bloqueado para origem: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json());
app.use(session({
  secret: "segredo",
  resave: true,
  saveUninitialized: false,
  cookie: { secure: false, sameSite: "lax" }
}));

// ─── CREDENCIAIS OAuth ────────────────────────────────────────────────────────
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// REDIRECT_URI dinâmico — obrigatório atualizar no Google Cloud Console em produção
const REDIRECT_URI = process.env.REDIRECT_URI || "http://localhost:3747/auth/callback";

// ─── PERSISTÊNCIA EM DISCO ────────────────────────────────────────────────────
const TOKENS_FILE = path.join(__dirname, "tokens.json");

function loadTokensFromDisk() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
      console.log("[GCal] ✓ tokens.json carregado do disco");
      return data;
    }
  } catch (e) {
    console.warn("[GCal] ⚠ Erro ao ler tokens.json:", e.message);
  }
  console.log("[GCal] ℹ Nenhum tokens.json encontrado — aguardando login");
  return { access_token: null, refresh_token: null, expiry_date: null };
}

function saveTokensToDisk(tokens) {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), "utf8");
    console.log("[GCal] ✓ tokens.json salvo no disco");
  } catch (e) {
    console.error("[GCal] ✗ Erro ao salvar tokens.json:", e.message);
  }
}

const tokenStore = loadTokensFromDisk();

// ─── INSTÂNCIA ÚNICA do OAuth2 ────────────────────────────────────────────────
const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

oAuth2Client.on("tokens", (tokens) => {
  console.log("[GCal] ♻ Token renovado automaticamente pelo listener");
  if (tokens.refresh_token) {
    tokenStore.refresh_token = tokens.refresh_token;
    console.log("[GCal] ✓ Novo refresh_token salvo");
  }
  tokenStore.access_token = tokens.access_token;
  tokenStore.expiry_date  = tokens.expiry_date || null;
  saveTokensToDisk(tokenStore);
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
    const err = new Error("Sem refresh_token — faça login com Google");
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
      saveTokensToDisk(tokenStore);
      applyTokens();
      console.log("[GCal] ✓ access_token renovado com sucesso");
    } catch (e) {
      console.error("[GCal] ✗ Falha ao renovar token:", e.message);
      tokenStore.access_token  = null;
      tokenStore.refresh_token = null;
      tokenStore.expiry_date   = null;
      saveTokensToDisk(tokenStore);
      const err = new Error("refresh_token inválido — faça login novamente");
      err.precisaRelogin = true;
      throw err;
    }
  }

  return oAuth2Client;
}

// ─── LOGIN DO SISTEMA ─────────────────────────────────────────────────────────
// Credenciais fixas de acesso ao sistema pericial
const LOGIN_EMAIL = "rmcontabilizando@gmail.com";
const LOGIN_SENHA = "sistema01";

app.post("/login", (req, res) => {
  const { email, senha } = req.body;
  if (email === LOGIN_EMAIL && senha === LOGIN_SENHA) {
    req.session.user = { logado: true };
    console.log("[Auth] ✓ Login realizado");
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
    console.log("[Auth] ✓ Sessão encerrada");
    res.json({ ok: true });
  });
});

// ─── STATUS GCAL ─────────────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  const conectado = !!tokenStore.refresh_token;
  res.json({
    conectado,
    logado:  conectado,
    email:   req.session.email || (conectado ? "rmcontabilizando@gmail.com" : null),
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

app.get("/auth/callback", async (req, res) => {
  try {
    const { tokens } = await oAuth2Client.getToken(req.query.code);

    if (tokens.refresh_token) {
      tokenStore.refresh_token = tokens.refresh_token;
      console.log("[GCal] ✓ Novo refresh_token recebido e salvo");
    } else {
      console.warn("[GCal] ⚠ refresh_token NÃO retornado pelo Google");
      console.warn("[GCal] ⚠ Usando refresh_token anterior:", tokenStore.refresh_token ? "existe" : "AUSENTE");
    }

    tokenStore.access_token = tokens.access_token;
    tokenStore.expiry_date  = tokens.expiry_date || null;
    saveTokensToDisk(tokenStore);
    applyTokens();

    req.session.tokens = tokens;
    req.session.email  = "rmcontabilizando@gmail.com";

    console.log("[GCal] ✓ Login Google concluído — tokens salvos em disco");

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
      console.log("[GCal] ✓ EVENTO ATUALIZADO:", response.data.id);
      return res.json({ ok: true, id: response.data.id, atualizado: true });
    } else {
      response = await calendar.events.insert({ calendarId: targetCal, requestBody: eventBody });
      console.log("[GCal] ✓ EVENTO CRIADO:", response.data.id);
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

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3747;
app.listen(PORT, () => {
  console.log(`[GCal] Servidor rodando na porta ${PORT}`);
  if (!tokenStore.refresh_token) {
    console.warn("[GCal] ⚠ Nenhum token Google encontrado. Acesse /auth para conectar.");
  } else {
    console.log("[GCal] ✓ Token carregado — Google Calendar pronto");
  }
});