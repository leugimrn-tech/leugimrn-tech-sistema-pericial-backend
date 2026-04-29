import { useState, useEffect, useCallback, useRef, memo, useMemo } from "react";

// ─── CONSTANTES GLOBAIS ───────────────────────────────────────────────────────
// API_URL: em produção, defina REACT_APP_API_URL no .env ou painel do host
const API_URL      = process.env.REACT_APP_API_URL || "http://localhost:3747";
const GCAL_BACKEND = API_URL;
const LOCAL_KEY    = "pericial_v3";
const API_BASE     = null;

const COLS = [
  { id:"honorarios", label:"Proposta honorários",  color:"#D97706" },
  { id:"diligencia", label:"Diligência documental", color:"#A855F7" },
  { id:"execucao",   label:"Em execução",           color:"#3B82F6" },
  { id:"impugnacao", label:"Responder impugnação",  color:"#EF4444" },
  { id:"entregue",   label:"Entregue / aguardando", color:"#10B981" },
  { id:"finalizado", label:"Finalizado / recebido", color:"#059669" },
];
const TIPOS     = ["Bancária","PASEP","Imobiliário","Trabalhista","Tributária","Fazenda","Financeira","Outra"];
const TRIBUNAIS = ["TJRN","TJPB","TJMG","TJSP","TJPR","TJAC","TJAL","TJAP","TJAM","TJBA","TJCE","TJDFT",
  "TJES","TJGO","TJMA","TJMT","TJMS","TJPA","TJPE","TJPI","TJRJ","TJRS","TJRO","TJRR","TJSC",
  "TJSE","TJTO","TRT21","TRF5","JFRN","Outro"];
const FASES      = ["Conhecimento","Instrução","Saneamento","Execução","Cumprimento de Sentença","Liquidação","Recursal","Outra"];
const STATUS_LIST= ["Início dos trabalhos periciais","Efetuar laudo","Responder impugnação","Diligência","Aguardar documentos","Aguardando depósito de honorários","Finalizado"];
const VARAS      = {
  TJRN: ["1ª Vara Cível","2ª Vara Cível","3ª Vara Cível","4ª Vara Cível","5ª Vara Cível","6ª Vara Cível","7ª Vara Cível","8ª Vara Cível","Vara da Fazenda Pública","Vara de Família","JEC Cível","Outro"],
  TJPB: ["1ª Vara Cível","2ª Vara Cível","Vara da Fazenda","JEC","Outro"],
  TRT21:["1ª Vara do Trabalho","2ª Vara do Trabalho","3ª Vara do Trabalho","4ª Vara do Trabalho","5ª Vara do Trabalho","Outro"],
  TRF5: ["1ª Vara Federal","2ª Vara Federal","Juizado Especial Federal","Outro"],
  JFRN: ["1ª Vara Federal","2ª Vara Federal","3ª Vara Federal","JEF","Outro"],
  JEC:  ["JEC Cível","JEC Criminal","JEC Fazenda Pública","Outro"],
  Outro:["Vara Única","Outro"],
};
const ETAPA_CORES = {
  "Responder impugnação":              { bg:"#2D1B00", border:"#92400E", badge:"#D97706" },
  "Aguardando depósito de honorários": { bg:"#1A2A0A", border:"#3B6012", badge:"#65A30D" },
  "Efetuar laudo":                     { bg:"#0D1F3C", border:"#1D4ED8", badge:"#3B82F6" },
  "Início dos trabalhos periciais":    { bg:"#1F0D2A", border:"#7C3AED", badge:"#A78BFA" },
  "Diligência":                        { bg:"#0D2020", border:"#0F766E", badge:"#2DD4BF" },
  "Aguardar documentos":               { bg:"#1F1F1F", border:"#3F3F46", badge:"#9CA3AF" },
  "Finalizado":                        { bg:"#0A1F12", border:"#064E2A", badge:"#10B981" },
};
const TRIBUNAL_MAP = {
  TJRN: { alias:"tjrn",  portal:"https://esaj.tjrn.jus.br/cpopg/search.do?cbPesquisa=NUMPROC&dadosConsulta.valorConsultaNuUnificado={NUM}" },
  TJPB: { alias:"tjpb",  portal:"https://pje.tjpb.jus.br/pje/ConsultaPublica/listView.seam" },
  TRT21:{ alias:"trt21", portal:"https://pje.trt21.jus.br/consultaprocessual/detalhe-processo/{NUM}" },
  TRF5: { alias:"trf5",  portal:"https://pje1g.trf5.jus.br/pje/ConsultaPublica/listView.seam" },
  JFRN: { alias:"jfrn",  portal:"https://pje1g.trf5.jus.br/pje/ConsultaPublica/listView.seam" },
};

// ─── MIGRAÇÃO DE COLUNA LEGADA ────────────────────────────────────────────────
const migrateCol = col => col === "aguardando" ? "diligencia" : col;

const EMPTY = {
  id:null, col:"honorarios", owner:"",
  processo:"", tribunal:"TJRN", tipo:"PASEP", fase:"Conhecimento",
  status_pericial:"Início dos trabalhos periciais",
  autor:"", reu:"", vara:"", proximo:"", ultima_mov:"",
  prazo_fase:"", prazo_laudo:"",
  honorarios:"", pagamentos:[],
  obs:"", tasks:[],
  gcal_fase_id:"", gcal_laudo_id:"",
  gcal_fase_date:"", gcal_laudo_date:"",
  gcal_calendar:"primary",
};

// ─── STORAGE / API LAYER ──────────────────────────────────────────────────────
const localRead  = () => { try { return JSON.parse(localStorage.getItem(LOCAL_KEY)||"[]").map(c=>({...c,col:migrateCol(c.col)})); } catch { return []; } };
const localWrite = d  => { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(d)); } catch {} };
const apiLayer = {
  getAll:   async ()    => { if (!API_BASE) return localRead(); return fetch(`${API_BASE}/processos`).then(r=>r.json()).then(d=>d.map(c=>({...c,col:migrateCol(c.col)}))); },
  create:   async (c)   => { if (!API_BASE) { const n={...c,id:Date.now()}; localWrite([...localRead(),n]); return n; } return fetch(`${API_BASE}/processos`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(c)}).then(r=>r.json()); },
  update:   async (c)   => { if (!API_BASE) { localWrite(localRead().map(x=>x.id===c.id?c:x)); return c; } return fetch(`${API_BASE}/processos/${c.id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(c)}).then(r=>r.json()); },
  remove:   async (id)  => { if (!API_BASE) { localWrite(localRead().filter(x=>x.id!==id)); return; } await fetch(`${API_BASE}/processos/${id}`,{method:"DELETE"}); },
  patchCol: async (id,col) => { if (!API_BASE) { localWrite(localRead().map(x=>x.id===id?{...x,col}:x)); return; } await fetch(`${API_BASE}/processos/${id}/col`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({col})}); },
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const fmt        = v => v ? `R$ ${Number(v).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})}` : "R$ 0,00";
const todayStr   = new Date().toISOString().slice(0,10);
const toGcalDate = d => (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? `${d}T00:00:00-03:00` : (d||null);
const parseCNJ   = s => { const c=s.replace(/\D/g,""); if(c.length!==20) return null; return {nproc:c.slice(0,7),digito:c.slice(7,9),ano:c.slice(9,13),j:c.slice(13,14),tr:c.slice(14,16),origem:c.slice(16,20)}; };
const inferTrib  = cnj => { if(!cnj) return null; if(cnj.j==="8"&&cnj.tr==="20") return "TJRN"; if(cnj.j==="8"&&cnj.tr==="15") return "TJPB"; if(cnj.j==="5"&&cnj.tr==="21") return "TRT21"; if(cnj.j==="4"&&cnj.tr==="05") return "TRF5"; return null; };
const prazoColor = p => { if(!p) return null; const d=Math.ceil((new Date(p)-new Date(todayStr))/86400000); if(d<0) return {bg:"#3B1515",txt:"#FCA5A5",brd:"#7F1D1D",label:`Vencido há ${Math.abs(d)}d`}; if(d<=1) return {bg:"#3B1515",txt:"#FCA5A5",brd:"#7F1D1D",label:d===0?"Vence hoje":"Amanhã"}; if(d<=3) return {bg:"#3B2A0A",txt:"#FCD34D",brd:"#78350F",label:`${d}d`}; if(d<=5) return {bg:"#2D2000",txt:"#FDE68A",brd:"#854F0B",label:`${d}d`}; return {bg:"#0A2010",txt:"#6EE7B7",brd:"#064E2A",label:`${d}d`}; };
const totalPago  = pags => (pags||[]).reduce((s,p)=>s+(parseFloat(p.valor)||0),0);

// ─── INFERÊNCIA AUTOMÁTICA DE COLUNA ─────────────────────────────────────────
const inferColByText = texto => {
  const t = (texto||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  if (/diligencia|documento/.test(t)) return "diligencia";
  if (/impugnacao/.test(t))           return "impugnacao";
  if (/laudo|execucao/.test(t))       return "execucao";
  if (/entrega/.test(t))              return "entregue";
  if (/finalizado|pago/.test(t))      return "finalizado";
  return null;
};

// ─── STYLES ───────────────────────────────────────────────────────────────────
const s = {
  inp:  { width:"100%", background:"#1E1E1E", border:"1px solid #333", borderRadius:6, color:"#E5E7EB", padding:"7px 10px", fontSize:13, outline:"none", boxSizing:"border-box" },
  lbl:  { fontSize:11, color:"#9CA3AF", display:"block", marginBottom:3 },
  btn:  (bg="#1E1E1E", tc="#E5E7EB", bc="#444") => ({ background:bg, color:tc, border:`1px solid ${bc}`, borderRadius:6, padding:"6px 14px", cursor:"pointer", fontSize:12, fontWeight:500 }),
  tab:  on => ({ background:on?"#1E3A5F":"transparent", border:`1px solid ${on?"#3B82F6":"transparent"}`, borderRadius:6, padding:"4px 11px", fontSize:11, cursor:"pointer", color:on?"#93C5FD":"#9CA3AF" }),
  row:  { marginBottom:10 },
  g2:   { display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:10 },
};

// ─── TELA DE LOGIN ────────────────────────────────────────────────────────────
const TelaLogin = ({ onLogin }) => {
  const [email,  setEmail]  = useState("");
  const [senha,  setSenha]  = useState("");
  const [erro,   setErro]   = useState("");
  const [busy,   setBusy]   = useState(false);

  const handleLogin = async () => {
    if (!email.trim() || !senha.trim()) { setErro("Preencha email e senha."); return; }
    setBusy(true); setErro("");
    try {
      const r = await fetch(`${API_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), senha }),
      });
      const d = await r.json();
      if (r.ok && d.ok) { onLogin(); }
      else setErro(d.erro || "Email ou senha incorretos.");
    } catch { setErro("Erro ao conectar com o servidor."); }
    setBusy(false);
  };

  return (
    <div style={{minHeight:"100vh",background:"#0A0A0A",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"var(--font-sans)"}}>
      <div style={{background:"#111",border:"1px solid #1E1E1E",borderRadius:14,padding:"36px 32px",width:"min(380px,92vw)"}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{fontSize:24,fontWeight:700,color:"#F9FAFB",marginBottom:4}}>⚖ Gestão Pericial</div>
          <div style={{fontSize:12,color:"#4B5563"}}>Faça login para continuar</div>
        </div>

        <div style={s.row}>
          <label style={s.lbl}>Email</label>
          <input
            type="email" value={email}
            onChange={e=>setEmail(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&handleLogin()}
            style={s.inp} placeholder="seu@email.com" autoFocus
          />
        </div>
        <div style={s.row}>
          <label style={s.lbl}>Senha</label>
          <input
            type="password" value={senha}
            onChange={e=>setSenha(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&handleLogin()}
            style={s.inp} placeholder="••••••••"
          />
        </div>

        {erro && (
          <div style={{fontSize:11,color:"#FCA5A5",background:"#3B1515",border:"1px solid #7F1D1D",borderRadius:5,padding:"6px 10px",marginBottom:10}}>
            {erro}
          </div>
        )}

        <button
          onClick={handleLogin} disabled={busy}
          style={{...s.btn("#1E3A5F","#93C5FD","#1D4ED8"),width:"100%",padding:"10px",fontSize:13,opacity:busy?.7:1,marginTop:4}}
        >
          {busy ? "Entrando…" : "Entrar"}
        </button>
      </div>
    </div>
  );
};

// ─── TELA DE SELEÇÃO DE DASHBOARD ────────────────────────────────────────────
const TelaSelecao = ({ onSelect }) => {
  const perfis = [
    { id:"miguel",    label:"Miguel",    sub:"Miguel Camilo · CRC-RN 012.142/O-5",       cor:"#3B82F6", hover:"#1E3A5F" },
    { id:"raphaella", label:"Raphaella", sub:"Raphaella Savanna · CRC-RN 012.481/O-0",   cor:"#A855F7", hover:"#2D1B4E" },
  ];
  return (
    <div style={{minHeight:"100vh",background:"#0A0A0A",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"var(--font-sans)"}}>
      <div style={{textAlign:"center",padding:"0 20px"}}>
        <div style={{fontSize:22,fontWeight:600,color:"#F9FAFB",marginBottom:6}}>Gestão Pericial</div>
        <div style={{fontSize:13,color:"#4B5563",marginBottom:40}}>Selecione o dashboard para continuar</div>
        <div style={{display:"flex",gap:16,justifyContent:"center",flexWrap:"wrap"}}>
          {perfis.map(p=>(
            <button key={p.id} onClick={()=>onSelect(p.id)}
              style={{background:"#111",border:`1px solid ${p.cor}33`,borderRadius:12,padding:"28px 36px",cursor:"pointer",minWidth:200,transition:"all .15s"}}
              onMouseEnter={e=>{e.currentTarget.style.background=p.hover;e.currentTarget.style.borderColor=p.cor;}}
              onMouseLeave={e=>{e.currentTarget.style.background="#111";e.currentTarget.style.borderColor=`${p.cor}33`;}}>
              <div style={{width:56,height:56,borderRadius:"50%",background:`${p.cor}22`,border:`2px solid ${p.cor}`,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 14px",fontSize:22,color:p.cor,fontWeight:700}}>
                {p.label[0]}
              </div>
              <div style={{fontSize:16,fontWeight:600,color:"#F3F4F6",marginBottom:4}}>{p.label}</div>
              <div style={{fontSize:10,color:"#6B7280",lineHeight:1.4}}>{p.sub}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

// ─── COMPONENTES SIMPLES ──────────────────────────────────────────────────────
const Spin = () => <span style={{width:11,height:11,border:"2px solid rgba(147,197,253,.3)",borderTopColor:"#93C5FD",borderRadius:"50%",display:"inline-block",animation:"spin .7s linear infinite"}}/>;

const MsgBar = memo(({ m, onClose }) => {
  if (!m) return null;
  const C = { ok:{bg:"#0A2E1A",tc:"#6EE7B7",bc:"#064E2A"}, warn:{bg:"#3B2A0A",tc:"#FCD34D",bc:"#78350F"}, err:{bg:"#3B1515",tc:"#FCA5A5",bc:"#7F1D1D"} };
  const c = C[m.type]||C.warn;
  return <div style={{fontSize:11,padding:"5px 10px",borderRadius:5,background:c.bg,color:c.tc,border:`1px solid ${c.bc}`,display:"flex",justifyContent:"space-between",marginTop:6,gap:8}}><span>{m.text}</span><button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",color:c.tc,padding:0}}>✕</button></div>;
});

const GcalFeedback = memo(({ msg, ok }) => {
  if (!msg) return null;
  return <div style={{fontSize:10,marginTop:3,padding:"3px 8px",borderRadius:4,background:ok?"#0A2E1A":"#3B1515",color:ok?"#6EE7B7":"#FCA5A5",border:`1px solid ${ok?"#064E2A":"#7F1D1D"}`,display:"inline-block"}}>{msg}</div>;
});

const Field = memo(({ label, value, onChange, type="text", opts, placeholder, rows }) => {
  const handle = useCallback(e=>onChange(e.target.value),[onChange]);
  return (
    <div style={s.row}>
      {label&&<label style={s.lbl}>{label}</label>}
      {opts ? <select value={value} onChange={handle} style={s.inp}>{opts.map(o=><option key={o} value={o}>{o}</option>)}</select>
           : rows ? <textarea value={value} onChange={handle} rows={rows} style={{...s.inp,resize:"vertical"}} placeholder={placeholder}/>
           : <input type={type} value={value} onChange={handle} style={s.inp} placeholder={placeholder}/>}
    </div>
  );
});

const VaraField = memo(({ tribunal, value, onChange }) => {
  const [q,setQ]       = useState(value||"");
  const [open,setOpen] = useState(false);
  const opts = VARAS[tribunal]||VARAS["Outro"];
  const filt = opts.filter(o=>o.toLowerCase().includes(q.toLowerCase()));
  useEffect(()=>setQ(value||""),[value]);
  const pick = useCallback(opt=>{ setQ(opt); onChange(opt); setOpen(false); },[onChange]);
  return (
    <div style={{position:"relative",marginBottom:10}}>
      <label style={s.lbl}>Órgão julgador / Vara</label>
      <input value={q} onChange={e=>{setQ(e.target.value);onChange(e.target.value);setOpen(true);}} onFocus={()=>setOpen(true)} onBlur={()=>setTimeout(()=>setOpen(false),150)} style={s.inp} placeholder="Digite ou selecione…"/>
      {open&&filt.length>0&&<div style={{position:"absolute",zIndex:200,top:"100%",left:0,right:0,background:"#1E1E1E",border:"1px solid #333",borderRadius:6,maxHeight:150,overflowY:"auto",marginTop:2}}>
        {filt.map(o=><div key={o} onMouseDown={()=>pick(o)} style={{padding:"7px 10px",fontSize:12,color:"#D1D5DB",cursor:"pointer",borderBottom:"1px solid #2A2A2A"}} onMouseEnter={e=>e.target.style.background="#2A2A2A"} onMouseLeave={e=>e.target.style.background="transparent"}>{o}</div>)}
      </div>}
    </div>
  );
});

const GcalCalendarSelector = memo(({ value, onChange }) => {
  const [cals,setCals] = useState([]);
  useEffect(()=>{ fetch(`${API_URL}/calendars`).then(r=>r.ok?r.json():null).then(d=>{if(d?.calendars)setCals(d.calendars);}).catch(()=>{}); },[]);
  if (cals.length<=1) return null;
  return (
    <div style={s.row}>
      <label style={s.lbl}>Calendário de destino</label>
      <select value={value} onChange={e=>onChange(e.target.value)} style={s.inp}>
        {cals.map(c=><option key={c.id} value={c.id}>{c.summary}{c.primary?" (principal)":""}</option>)}
      </select>
    </div>
  );
});

// ─── HOOKS ────────────────────────────────────────────────────────────────────
const useDatajud = (onField) => {
  const [busy, setBusy] = useState(false);
  const [msg,  setMsg]  = useState(null);

  const buscar = useCallback(async (processo, tribunal) => {
    if (!processo.trim()) return;
    const cnj  = parseCNJ(processo);
    const trib = inferTrib(cnj) || tribunal;

    setMsg({ type:"warn", text:"Consultando DataJud…" });
    setBusy(true);

    try {
      const r = await backendFetch(`/datajud/${encodeURIComponent(trib)}/${encodeURIComponent(processo.trim())}`);
      const d = await r.json();

      if (!r.ok || d.erro) {
        setMsg({ type:"warn", text: d.detalhe || "Erro ao acessar DataJud." });
        setBusy(false); return;
      }

      if (!d.encontrado) {
        if (trib) onField("tribunal", trib);
        setMsg({ type:"warn", text:"Processo não encontrado. Preencha manualmente." });
        setBusy(false); return;
      }

      if (trib)       onField("tribunal",   trib);
      if (d.vara)     onField("vara",        d.vara);
      if (d.autor)    onField("autor",       d.autor);
      if (d.reu)      onField("reu",         d.reu);
      if (d.ultima_mov) onField("ultima_mov", d.ultima_mov);

      setMsg({ type:"ok", text:`✓ ${d.total_movs} movimentações · ${d.total_partes} partes` });

    } catch (e) {
      setMsg({ type:"warn", text:"Erro ao conectar com o servidor." });
    }

    setBusy(false);
  }, [onField]);

  return { busy, msg, setMsg, buscar };
};

const backendFetch = (path, opts={}) =>
  fetch(`${API_URL}${path}`,{method:opts.method||"GET",headers:{"Content-Type":"application/json",...(opts.headers||{})},credentials:"include",body:opts.body});

const usePrazoGcal = (gcalAuth) => {
  const [feedbacks,setFeedbacks] = useState({});
  const enviar = useCallback(async({summary,description,date,key})=>{
    if(!date||!gcalAuth) return;
    try {
      const r=await backendFetch("/criar-evento",{method:"POST",body:JSON.stringify({summary,description,start:{dateTime:toGcalDate(date),timeZone:"America/Sao_Paulo"},end:{dateTime:toGcalDate(date),timeZone:"America/Sao_Paulo"}})});
      let d={}; try{d=await r.json();}catch{}
      const ok=r.ok||d.ok;
      setFeedbacks(f=>({...f,[key]:{ok,msg:ok?"✓ Evento criado na agenda":"Falha ao criar evento"}}));
    } catch { setFeedbacks(f=>({...f,[key]:{ok:false,msg:"Erro ao conectar com servidor"}})); }
  },[gcalAuth]);
  return { enviar, feedbacks };
};

// ─── KANBAN CARD ──────────────────────────────────────────────────────────────
const KanbanCard = memo(({ card, onClick, onDragStart }) => {
  const ec=ETAPA_CORES[card.status_pericial]||{bg:"#1A1A1A",border:"#2A2A2A",badge:"#6B7280"};
  const tasks=card.tasks||[], hon=parseFloat(card.honorarios)||0, pend=hon-totalPago(card.pagamentos||[]);
  const pfase=prazoColor(card.prazo_fase), plaudo=prazoColor(card.prazo_laudo);
  const worst=[pfase,plaudo].filter(Boolean).sort((a,b)=>{const r=c=>c.txt==="#FCA5A5"?0:c.txt==="#FCD34D"?1:c.txt==="#FDE68A"?2:3;return r(a)-r(b);})[0];
  return (
    <div draggable onDragStart={onDragStart} onClick={onClick}
      style={{background:ec.bg,border:`1px solid ${worst?worst.brd:ec.border}`,borderRadius:9,padding:"9px 10px 8px",marginBottom:7,cursor:"grab",userSelect:"none"}}>
      {worst&&<div style={{fontSize:10,background:worst.bg,color:worst.txt,borderRadius:4,padding:"2px 6px",marginBottom:5,display:"inline-block"}}>{worst.label}</div>}
      <div style={{fontSize:13,fontWeight:600,color:"#E5E7EB",fontFamily:"monospace",letterSpacing:0.5,marginBottom:4}}>{card.processo||"—"}</div>
      <div style={{fontSize:12,fontWeight:500,color:"#E5E7EB",marginBottom:3}}>{card.tipo} · {card.tribunal}</div>
      {card.status_pericial&&<div style={{fontSize:10,background:ec.bg,color:ec.badge,border:`1px solid ${ec.border}`,borderRadius:4,padding:"1px 6px",display:"inline-block",marginBottom:4}}>{card.status_pericial}</div>}
      {card.fase&&<div style={{fontSize:10,color:"#60A5FA",marginBottom:3}}>{card.fase}</div>}
      {(card.autor||card.reu)&&<div style={{fontSize:10,color:"#6B7280",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",marginBottom:3}}>{[card.autor,card.reu].filter(Boolean).join(" × ")}</div>}
      {card.prazo_laudo&&<div style={{fontSize:10,color:plaudo?.txt||"#6B7280",marginBottom:3}}>Laudo: {card.prazo_laudo}</div>}
      {tasks.length>0&&<div style={{fontSize:10,color:"#6B7280",marginBottom:4}}>✓ {tasks.filter(t=>t.done).length}/{tasks.length}{tasks.filter(t=>!t.done).length>0&&<span style={{color:"#FCD34D"}}> · {tasks.filter(t=>!t.done).length} pend.</span>}</div>}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:2}}>
        <span style={{fontSize:10,color:pend>0?"#FCD34D":hon>0?"#6EE7B7":"#4B5563"}}>{hon>0?(pend>0?`Pend: ${fmt(pend)}`:"Pago"):"Sem honorários"}</span>
        {hon>0&&<span style={{fontSize:10,color:"#4B5563"}}>{fmt(hon)}</span>}
      </div>
    </div>
  );
});

// ─── FINANCEIRO ───────────────────────────────────────────────────────────────
const FinanceiroTab = memo(({ form, onChange }) => {
  const [novoPag,setNovoPag] = useState({valor:"",data:todayStr,obs:""});
  const pags=form.pagamentos||[], hon=parseFloat(form.honorarios)||0, pago=totalPago(pags), now=new Date();
  const semana=pags.filter(p=>new Date(p.data)>=new Date(now-7*86400000)).reduce((s,p)=>s+(parseFloat(p.valor)||0),0);
  const mes=pags.filter(p=>{const d=new Date(p.data);return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();}).reduce((s,p)=>s+(parseFloat(p.valor)||0),0);
  const ano=pags.filter(p=>new Date(p.data).getFullYear()===now.getFullYear()).reduce((s,p)=>s+(parseFloat(p.valor)||0),0);
  const addPag=useCallback(()=>{if(!novoPag.valor||parseFloat(novoPag.valor)<=0)return;onChange("pagamentos",[...pags,{id:Date.now(),...novoPag}]);setNovoPag({valor:"",data:todayStr,obs:""});},[novoPag,pags,onChange]);
  const delPag=useCallback(id=>onChange("pagamentos",pags.filter(p=>p.id!==id)),[pags,onChange]);
  return (
    <div>
      <div style={s.g2}>
        <div style={{background:"#161616",border:"1px solid #222",borderRadius:7,padding:"8px 12px"}}><div style={{fontSize:10,color:"#6B7280"}}>Honorários</div><div style={{fontSize:16,fontWeight:500,color:"#E5E7EB"}}>{fmt(hon)}</div></div>
        <div style={{background:"#161616",border:"1px solid #222",borderRadius:7,padding:"8px 12px"}}><div style={{fontSize:10,color:"#6B7280"}}>Pendente</div><div style={{fontSize:16,fontWeight:500,color:hon-pago>0?"#FCD34D":"#6EE7B7"}}>{fmt(hon-pago)}</div></div>
      </div>
      <div style={s.row}><label style={s.lbl}>Valor dos honorários (R$)</label><input type="number" value={form.honorarios} onChange={e=>onChange("honorarios",e.target.value)} style={s.inp} placeholder="0.00"/></div>
      <div style={{background:"#161616",border:"1px solid #1E3A5F",borderRadius:8,padding:"12px",marginBottom:10}}>
        <div style={{fontSize:11,fontWeight:500,color:"#93C5FD",marginBottom:8}}>Registrar pagamento</div>
        <div style={s.g2}>
          <div><label style={s.lbl}>Valor (R$)</label><input type="number" value={novoPag.valor} onChange={e=>setNovoPag(p=>({...p,valor:e.target.value}))} style={s.inp}/></div>
          <div><label style={s.lbl}>Data</label><input type="date" value={novoPag.data} onChange={e=>setNovoPag(p=>({...p,data:e.target.value}))} style={s.inp}/></div>
        </div>
        <div style={s.row}><label style={s.lbl}>Observação</label><input value={novoPag.obs} onChange={e=>setNovoPag(p=>({...p,obs:e.target.value}))} style={s.inp} placeholder="Ex: 1ª parcela…"/></div>
        <button onClick={addPag} style={s.btn("#1E3A5F","#93C5FD","#1D4ED8")}>+ Registrar pagamento</button>
      </div>
      {pags.length>0&&<>
        <div style={{fontSize:11,color:"#6B7280",marginBottom:6}}>Histórico</div>
        {pags.map(p=><div key={p.id} style={{display:"flex",alignItems:"center",gap:8,background:"#161616",border:"1px solid #222",borderRadius:6,padding:"6px 10px",marginBottom:5}}>
          <div style={{flex:1}}><div style={{fontSize:12,color:"#6EE7B7",fontWeight:500}}>{fmt(p.valor)}</div><div style={{fontSize:10,color:"#4B5563"}}>{p.data}{p.obs&&` · ${p.obs}`}</div></div>
          <button onClick={()=>delPag(p.id)} style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:13}}>✕</button>
        </div>)}
        <div style={{display:"flex",justifyContent:"space-between",background:"#0A1F12",border:"1px solid #064E2A",borderRadius:6,padding:"6px 10px"}}><span style={{fontSize:11,color:"#6EE7B7"}}>Total pago</span><span style={{fontSize:12,fontWeight:500,color:"#6EE7B7"}}>{fmt(pago)}</span></div>
      </>}
      <div style={{marginTop:12,background:"#111",border:"1px solid #222",borderRadius:8,padding:"10px 12px"}}>
        <div style={{fontSize:11,color:"#6B7280",marginBottom:6}}>Recebimentos neste processo</div>
        {[["Esta semana",semana],["Este mês",mes],["Este ano",ano]].map(([l,v])=>(
          <div key={l} style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4}}><span style={{color:"#9CA3AF"}}>{l}</span><span style={{color:v>0?"#6EE7B7":"#4B5563",fontWeight:500}}>{fmt(v)}</span></div>
        ))}
      </div>
    </div>
  );
});

// ─── TAREFAS ──────────────────────────────────────────────────────────────────
const TarefasTab = memo(({ form, onChange }) => {
  const [nova,setNova] = useState("");
  const tasks=form.tasks||[], done=tasks.filter(t=>t.done).length, pct=tasks.length?Math.round(done/tasks.length*100):0;
  const add=useCallback(()=>{ const t=nova.trim(); if(!t) return; onChange("tasks",[...tasks,{id:Date.now(),text:t,done:false}]); const col=inferColByText(t); if(col) onChange("col",col); setNova(""); },[nova,tasks,onChange]);
  const tog=useCallback(id=>onChange("tasks",tasks.map(t=>t.id===id?{...t,done:!t.done}:t)),[tasks,onChange]);
  const del=useCallback(id=>onChange("tasks",tasks.filter(t=>t.id!==id)),[tasks,onChange]);
  const move=useCallback((id,dir)=>{ const ts=[...tasks],i=ts.findIndex(t=>t.id===id),j=i+dir; if(j<0||j>=ts.length) return; [ts[i],ts[j]]=[ts[j],ts[i]]; onChange("tasks",ts); },[tasks,onChange]);
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#6B7280",marginBottom:4}}><span>{done}/{tasks.length} concluídas</span><span>{pct}%</span></div>
      <div style={{height:5,background:"#2A2A2A",borderRadius:4,overflow:"hidden",marginBottom:12}}><div style={{height:"100%",width:`${pct}%`,background:pct===100?"#10B981":pct>=50?"#3B82F6":"#D97706",borderRadius:4,transition:"width .3s"}}/></div>
      {tasks.length===0&&<p style={{fontSize:12,color:"#374151",textAlign:"center",margin:"12px 0"}}>Sem tarefas ainda.</p>}
      {tasks.map((t,i)=>(
        <div key={t.id} style={{display:"flex",alignItems:"center",gap:7,padding:"6px 9px",borderRadius:6,background:t.done?"#161616":"#1A1A1A",border:"1px solid #2A2A2A",marginBottom:5}}>
          <input type="checkbox" checked={t.done} onChange={()=>tog(t.id)} style={{accentColor:"#3B82F6",flexShrink:0}}/>
          <span style={{flex:1,fontSize:12,color:t.done?"#4B5563":"#D1D5DB",textDecoration:t.done?"line-through":"none"}}>{t.text}</span>
          <button onClick={()=>move(t.id,-1)} disabled={i===0} style={{background:"none",border:"none",color:"#4B5563",cursor:"pointer",fontSize:11}}>↑</button>
          <button onClick={()=>move(t.id,1)}  disabled={i===tasks.length-1} style={{background:"none",border:"none",color:"#4B5563",cursor:"pointer",fontSize:11}}>↓</button>
          <button onClick={()=>del(t.id)} style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:12}}>✕</button>
        </div>
      ))}
      <div style={{display:"flex",gap:6,marginTop:8}}>
        <input value={nova} onChange={e=>setNova(e.target.value)} onKeyDown={e=>e.key==="Enter"&&add()} placeholder="Nova tarefa… (Enter)" style={s.inp}/>
        <button onClick={add} style={s.btn("#1E3A5F","#93C5FD","#1D4ED8")}>+</button>
      </div>
      {tasks.some(t=>t.done)&&<button onClick={()=>onChange("tasks",tasks.filter(t=>!t.done))} style={{...s.btn("#3B1515","#FCA5A5","#7F1D1D"),marginTop:8,fontSize:11}}>Remover concluídas</button>}
    </div>
  );
});

// ─── MODAL FORM ───────────────────────────────────────────────────────────────
const ModalForm = memo(({ form, onField, onSave, onDelete, onClose, saving, gcalAuth, setGcalAuth, loginGoogle, gcalChecking, setGcalChecking }) => {
  const [tab,setTab]           = useState("dados");
  const [gcalBusy,setGcalBusy] = useState(false);
  const [gcalMsg,setGcalMsg]   = useState(null);

  async function atualizarConexao() {
    setGcalChecking(true);
    try { const res=await fetch(`${API_URL}/status`,{credentials:"include"}),data=await res.json(); if(data.conectado&&data.email) setGcalAuth({email:data.email,name:data.name||""}); else setGcalAuth(null); } catch { setGcalAuth(null); }
    setGcalChecking(false);
  }

  const {enviar:enviarGcal,feedbacks:gcalFeedbacks} = usePrazoGcal(gcalAuth);
  const setFormField = useCallback((f,v)=>onField(f,v),[onField]);
  const {busy:djBusy,msg:djMsg,setMsg:setDjMsg,buscar} = useDatajud(setFormField);

  const prazoFaseTimer=useRef(null), prazoLaudoTimer=useRef(null);

  const handlePrazoFase = useCallback((val)=>{
    onField("prazo_fase",val); if(!val||!gcalAuth) return;
    if(prazoFaseTimer.current) clearTimeout(prazoFaseTimer.current);
    prazoFaseTimer.current=setTimeout(()=>enviarGcal({key:"prazo_fase",summary:`⚖️ ${form.processo||"Processo"} – Fase: ${form.fase}`,description:`Fase: ${form.fase}\nStatus: ${form.status_pericial}\nPróx: ${form.proximo||"—"}\nAutor: ${form.autor||"—"}\nRéu: ${form.reu||"—"}\nObs: ${form.obs||"—"}`,date:val}),800);
  },[form,gcalAuth,enviarGcal,onField]);

  const handlePrazoLaudo = useCallback((val)=>{
    onField("prazo_laudo",val); if(!val||!gcalAuth) return;
    if(prazoLaudoTimer.current) clearTimeout(prazoLaudoTimer.current);
    prazoLaudoTimer.current=setTimeout(()=>enviarGcal({key:"prazo_laudo",summary:`📋 ${form.processo||"Processo"} – Laudo`,description:`Processo: ${form.processo}`,date:val}),800);
  },[form,gcalAuth,enviarGcal,onField]);

  const criarAgenda = useCallback(async()=>{
    if(!form.prazo_fase&&!form.prazo_laudo){alert("Informe ao menos um prazo.");return;}
    if(!gcalAuth){setGcalMsg({type:"warn",text:"Faça login com Google antes."});return;}
    setGcalBusy(true);setGcalMsg(null);
    const desc=[`Processo: ${form.processo}`,`Tipo: ${form.tipo}`,`Fase: ${form.fase}`,`Tribunal: ${form.tribunal}`,`Vara: ${form.vara||"—"}`,`Autor: ${form.autor||"—"}`,`Réu: ${form.reu||"—"}`,`Próx: ${form.proximo||"—"}`].join("\n");
    const oldFaseDate=form.gcal_fase_date, oldLaudoDate=form.gcal_laudo_date, eventos=[];
    if(form.gcal_laudo_id&&oldLaudoDate&&form.prazo_laudo!==oldLaudoDate){await backendFetch("/deletar-evento",{method:"POST",body:JSON.stringify({eventId:form.gcal_laudo_id})});onField("gcal_laudo_id",null);onField("gcal_laudo_date",null);}
    if(form.gcal_fase_id&&oldFaseDate&&form.prazo_fase!==oldFaseDate){await backendFetch("/deletar-evento",{method:"POST",body:JSON.stringify({eventId:form.gcal_fase_id})});onField("gcal_fase_id",null);onField("gcal_fase_date",null);}
    if(form.prazo_fase)  eventos.push({tipo:"fase",  summary:`⚖️ ${form.processo} – Fase (${form.fase})`,  start:{dateTime:toGcalDate(form.prazo_fase), timeZone:"America/Sao_Paulo"},colorId:"11",reminders:[2880,1440,180],eventId:form.gcal_fase_id});
    if(form.prazo_laudo) eventos.push({tipo:"laudo", summary:`📋 ${form.processo} – Laudo (${form.tipo})`, start:{dateTime:toGcalDate(form.prazo_laudo),timeZone:"America/Sao_Paulo"},colorId:"9", reminders:[4320,1440,180],eventId:form.gcal_laudo_id});
    let ok=0,erros=[],precisaRelogin=false;
    for(const ev of eventos){
      try{
        const r=await backendFetch("/criar-evento",{method:"POST",body:JSON.stringify({calendarId:form.gcal_calendar||"primary",summary:ev.summary,description:desc,start:ev.start,eventId:ev.eventId||null})});
        const d=await r.json();
        if(r.ok){ok++;if(d?.id){if(ev.tipo==="fase"){onField("gcal_fase_id",d.id);onField("gcal_fase_date",form.prazo_fase);}if(ev.tipo==="laudo"){onField("gcal_laudo_id",d.id);onField("gcal_laudo_date",form.prazo_laudo);}}}
        else{if(d?.precisaRelogin)precisaRelogin=true;erros.push(d?.detalhe||d?.erro||"erro");}
      }catch(e){erros.push(e.message);}
    }
    let msg;
    if(ok>0&&erros.length===0) msg=form.gcal_fase_id||form.gcal_laudo_id?{type:"ok",text:"✓ Evento sincronizado com sucesso"}:{type:"ok",text:`✓ ${ok} evento(s) criado(s) em ${gcalAuth?.email}`};
    else if(ok>0) msg={type:"warn",text:`${ok} criado(s), ${erros.length} erro(s)`};
    else if(precisaRelogin) msg={type:"err",text:"Sessão do Google expirou. Clique em 'Sair' e reconecte."};
    else msg={type:"err",text:`Falha: ${erros.join(", ")}`};
    setGcalMsg(msg);setGcalBusy(false);
  },[form,gcalAuth,onField]);

  const handleFaseChange=useCallback((val)=>{onField("fase",val);const col=inferColByText(val);if(col)onField("col",col);},[onField]);

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:"#111",borderRadius:12,padding:"18px 20px",width:"min(580px,97vw)",maxHeight:"92vh",overflowY:"auto",border:"1px solid #2A2A2A"}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
          <h3 style={{margin:0,fontSize:14,fontWeight:500,color:"#F3F4F6"}}>{form.id?"Editar":"Novo processo"}</h3>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#6B7280",cursor:"pointer",fontSize:17}}>✕</button>
        </div>
        <div style={{display:"flex",gap:4,marginBottom:12,borderBottom:"1px solid #1E1E1E",paddingBottom:10,flexWrap:"wrap"}}>
          {["dados","partes","financeiro","tarefas","prazos"].map(t=>(
            <button key={t} onClick={()=>setTab(t)} style={s.tab(tab===t)}>
              {t==="tarefas"?`Tarefas${form.tasks?.length?` (${form.tasks.filter(x=>!x.done).length} pend.)`:""}`:t.charAt(0).toUpperCase()+t.slice(1)}
            </button>
          ))}
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

        {tab==="dados"&&<>
          <div style={s.row}>
            <label style={s.lbl}>Número CNJ</label>
            <div style={{display:"flex",gap:6}}>
              <input value={form.processo} onChange={e=>onField("processo",e.target.value)} style={s.inp} placeholder="0000000-00.0000.8.20.0001"/>
              <button onClick={()=>buscar(form.processo,form.tribunal)} disabled={djBusy||!form.processo.trim()} style={{...s.btn("#1E3A5F","#93C5FD","#1D4ED8"),whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:4}}>
                {djBusy?<><Spin/> Buscando…</>:<>⌕ DataJud</>}
              </button>
            </div>
            {form.processo&&parseCNJ(form.processo)&&(()=>{ const cnj=parseCNJ(form.processo),trib=inferTrib(cnj),tm=TRIBUNAL_MAP[trib]; return (
              <div style={{display:"flex",gap:7,marginTop:4,flexWrap:"wrap",alignItems:"center"}}>
                <span style={{fontSize:10,background:"#0A2E1A",color:"#6EE7B7",border:"1px solid #064E2A",borderRadius:4,padding:"1px 7px"}}>CNJ válido · {cnj.ano} · {trib||"—"}</span>
                {tm?.portal&&<a href={tm.portal.replace("{NUM}",encodeURIComponent(form.processo))} target="_blank" rel="noreferrer" style={{fontSize:10,color:"#60A5FA"}}>Portal ↗</a>}
              </div>
            );})()}
            <MsgBar m={djMsg} onClose={()=>setDjMsg(null)}/>
          </div>
          <div style={s.g2}>
            <div style={s.row}><label style={s.lbl}>Tribunal</label><select value={form.tribunal} onChange={e=>{onField("tribunal",e.target.value);onField("vara","");}} style={s.inp}>{TRIBUNAIS.map(o=><option key={o}>{o}</option>)}</select></div>
            <div style={s.row}><label style={s.lbl}>Tipo</label><select value={form.tipo} onChange={e=>onField("tipo",e.target.value)} style={s.inp}>{TIPOS.map(o=><option key={o}>{o}</option>)}</select></div>
          </div>
          <div style={s.g2}>
            <div style={s.row}><label style={s.lbl}>Fase</label><select value={form.fase} onChange={e=>handleFaseChange(e.target.value)} style={s.inp}>{FASES.map(o=><option key={o}>{o}</option>)}</select></div>
            <div style={s.row}><label style={s.lbl}>Status pericial</label><select value={form.status_pericial} onChange={e=>onField("status_pericial",e.target.value)} style={s.inp}>{STATUS_LIST.map(o=><option key={o}>{o}</option>)}</select></div>
          </div>
          <VaraField tribunal={form.tribunal} value={form.vara} onChange={v=>onField("vara",v)}/>
          <Field label="Próximo passo"       value={form.proximo}    onChange={v=>onField("proximo",v)}/>
          <Field label="Última movimentação" value={form.ultima_mov} onChange={v=>onField("ultima_mov",v)}/>
          <div style={s.row}><label style={s.lbl}>Coluna</label><select value={form.col} onChange={e=>onField("col",e.target.value)} style={s.inp}>{COLS.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></div>
          <Field label="Observações" value={form.obs} onChange={v=>onField("obs",v)} rows={2}/>
        </>}

        {tab==="partes"&&<>
          <Field label="Autor / polo ativo" value={form.autor} onChange={v=>onField("autor",v)} placeholder="Nome do autor"/>
          <Field label="Réu / polo passivo" value={form.reu}   onChange={v=>onField("reu",v)}   placeholder="Nome do réu"/>
          <div style={{background:"#161616",border:"1px solid #222",borderRadius:7,padding:"10px 12px",marginTop:6}}>
            {[["Processo",form.processo||"—"],["Fase",form.fase||"—"],["Vara",form.vara||"—"],["Autor",form.autor||"—"],["Réu",form.reu||"—"]].map(([l,v])=>(
              <div key={l} style={{display:"flex",gap:8,fontSize:12,marginBottom:4}}><span style={{color:"#6B7280",minWidth:60}}>{l}:</span><span style={{color:"#D1D5DB"}}>{v}</span></div>
            ))}
          </div>
        </>}

        {tab==="financeiro"&&<FinanceiroTab form={form} onChange={onField}/>}
        {tab==="tarefas"&&<TarefasTab form={form} onChange={onField}/>}

        {tab==="prazos"&&<>
          <div style={s.g2}>
            <div>
              <Field label="Prazo da fase atual" value={form.prazo_fase}  onChange={handlePrazoFase}  type="date"/>
              {form.prazo_fase&&(()=>{const c=prazoColor(form.prazo_fase);return c&&<div style={{fontSize:10,background:c.bg,color:c.txt,borderRadius:4,padding:"2px 7px",marginTop:-6,marginBottom:6,display:"inline-block"}}>{c.label}</div>;})()}
              <GcalFeedback msg={gcalFeedbacks["prazo_fase"]?.msg} ok={gcalFeedbacks["prazo_fase"]?.ok}/>
            </div>
            <div>
              <Field label="Prazo entrega laudo" value={form.prazo_laudo} onChange={handlePrazoLaudo} type="date"/>
              {form.prazo_laudo&&(()=>{const c=prazoColor(form.prazo_laudo);return c&&<div style={{fontSize:10,background:c.bg,color:c.txt,borderRadius:4,padding:"2px 7px",marginTop:-6,marginBottom:6,display:"inline-block"}}>{c.label}</div>;})()}
              <GcalFeedback msg={gcalFeedbacks["prazo_laudo"]?.msg} ok={gcalFeedbacks["prazo_laudo"]?.ok}/>
            </div>
          </div>
          {!gcalAuth&&<div style={{background:"#3B2A0A",border:"1px solid #78350F",borderRadius:6,padding:"8px 12px",marginBottom:10,fontSize:11,color:"#FCD34D"}}>⚠ Conecte sua conta Google para criar eventos automaticamente.</div>}
          <div style={{background:"#161616",border:"1px solid #1E3A5F",borderRadius:8,padding:"12px",marginBottom:10}}>
            <div style={{fontSize:12,fontWeight:500,color:"#93C5FD",marginBottom:8}}>Google Calendar</div>
            {gcalAuth?(
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:"#0A2E1A",border:"1px solid #064E2A",borderRadius:6,padding:"6px 10px",marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}><span>✓</span><div><div style={{fontSize:11,fontWeight:500,color:"#6EE7B7"}}>Conectado</div><div style={{fontSize:10,color:"#059669"}}>{gcalAuth.email}</div></div></div>
                <button onClick={()=>backendFetch("/auth/logout",{method:"POST"}).then(()=>setGcalAuth(null))} style={{...s.btn("#0D3321","#6EE7B7","#064E2A"),fontSize:10,padding:"2px 8px"}}>Sair</button>
              </div>
            ):gcalChecking?(
              <div style={{fontSize:11,color:"#93C5FD",marginBottom:10,padding:"6px 10px",background:"#1E3A5F",borderRadius:6,display:"flex",alignItems:"center",gap:6}}>
                <span style={{width:10,height:10,border:"1.5px solid rgba(147,197,253,.3)",borderTopColor:"#93C5FD",borderRadius:"50%",display:"inline-block",animation:"spin .7s linear infinite"}}/>
                Verificando autenticação…
              </div>
            ):(
              <div style={{display:"flex",gap:6,marginBottom:10,alignItems:"center"}}>
                <button onClick={loginGoogle} style={{...s.btn("#1E3A5F","#93C5FD","#1D4ED8"),display:"flex",alignItems:"center",gap:6}}>
                  <svg width="13" height="13" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
                  Entrar com Google
                </button>
                <button onClick={atualizarConexao} style={{...s.btn("#1A1A1A","#9CA3AF","#333"),fontSize:12}} title="Já fiz login, atualizar">↻ Atualizar conexão</button>
              </div>
            )}
            {gcalAuth&&<GcalCalendarSelector value={form.gcal_calendar||"primary"} onChange={v=>onField("gcal_calendar",v)}/>}
            <div style={{fontSize:11,color:"#4B5563",marginBottom:8,lineHeight:1.5}}><span style={{color:"#EF4444"}}>🔴</span> <b style={{color:"#9CA3AF"}}>Prazo fase</b> — 48h, 24h, 3h<br/><span style={{color:"#3B82F6"}}>🔵</span> <b style={{color:"#9CA3AF"}}>Entrega laudo</b> — 72h, 24h, 3h</div>
            <button onClick={criarAgenda} disabled={gcalBusy||!gcalAuth||(!form.prazo_fase&&!form.prazo_laudo)} style={{...s.btn(gcalAuth?"#0A2E1A":"#1A1A1A",gcalAuth?"#6EE7B7":"#4B5563",gcalAuth?"#064E2A":"#2A2A2A"),display:"flex",alignItems:"center",gap:6}}>
              {gcalBusy?<><Spin/> Criando…</>:"📅 Criar na agenda"}
            </button>
            <MsgBar m={gcalMsg} onClose={()=>setGcalMsg(null)}/>
          </div>
        </>}

        <div style={{display:"flex",justifyContent:"space-between",marginTop:16,gap:8,borderTop:"1px solid #1E1E1E",paddingTop:14}}>
          {form.id&&<button onClick={()=>onDelete(form.id)} disabled={saving} style={s.btn("#3B1515","#FCA5A5","#7F1D1D")}>Excluir</button>}
          <div style={{display:"flex",gap:8,marginLeft:"auto"}}>
            <button onClick={onClose} style={s.btn()}>Cancelar</button>
            <button onClick={onSave} disabled={saving} style={{...s.btn("#1E3A5F","#93C5FD","#1D4ED8"),opacity:saving?.6:1}}>{saving?"Salvando…":"Salvar"}</button>
          </div>
        </div>
      </div>
    </div>
  );
});

// ─── APP (raiz) ───────────────────────────────────────────────────────────────
export default function App() {
  const [cards,       setCards]       = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [saving,      setSaving]      = useState(false);
  const [err,         setErr]         = useState(null);
  const [modal,       setModal]       = useState(false);
  const [form,        setForm]        = useState(EMPTY);
  const [drag,        setDrag]        = useState(null);
  const [dragOver,    setDragOver]    = useState(null);
  const [search,      setSearch]      = useState("");
  const [ftipo,       setFtipo]       = useState("");
  const [gcalAuth,    setGcalAuth]    = useState(null);
  const [gcalChecking,setGcalChecking]= useState(true);

  // ── AUTENTICAÇÃO DO SISTEMA ─────────────────────────────────────────────────
  const [logado,  setLogado]  = useState(false);
  const [perfil,  setPerfil]  = useState(null);
  // ───────────────────────────────────────────────────────────────────────────

  // Sem sessão no backend — estado de login vive apenas no React
  // Ao recarregar a página o usuário precisa logar novamente (comportamento esperado)

  const handleLogout = useCallback(() => {
    setLogado(false);
    setPerfil(null);
  }, []);

  const checkGcalAuth = useCallback(async () => {
    setGcalChecking(true);
    try { const r=await backendFetch("/status"),d=await r.json(); if(d.conectado) setGcalAuth({email:d.email||"Conectado",name:d.name||""}); else setGcalAuth(null); } catch { setGcalAuth(null); }
    setGcalChecking(false);
  }, []);

  const atualizarConexao = useCallback(async () => {
    setGcalChecking(true);
    try { const r=await backendFetch("/status"),d=await r.json(); if(d.conectado) setGcalAuth({email:d.email||"Conectado",name:d.name||""}); else setGcalAuth(null); } catch { setGcalAuth(null); }
    setGcalChecking(false);
  }, []);

  const loginGoogle = useCallback(() => {
    window.open(`${GCAL_BACKEND}/auth`,"gcal_login","width=500,height=600,left=200,top=100");
    setGcalChecking(true);
    let attempts=0;
    const poll=setInterval(async()=>{ attempts++; const authed=await checkGcalAuth(); if(authed||attempts>=15){clearInterval(poll);setGcalChecking(false);} },2000);
  }, [checkGcalAuth]);

  const onField = useCallback((field,value)=>{ setForm(prev=>prev[field]===value?prev:{...prev,[field]:value}); },[]);

  const load = useCallback(async()=>{ setLoading(true); try{setCards(await apiLayer.getAll());}catch(e){setErr(e.message);} setLoading(false); },[]);
  useEffect(()=>{ load(); },[load]);
  useEffect(()=>{ checkGcalAuth(); },[checkGcalAuth]);
  useEffect(()=>{ if(perfil) load(); },[perfil]);

  const openNew  = useCallback(col=>{ setForm({...EMPTY,col,id:null,owner:perfil}); setModal(true); },[perfil]);
  const openEdit = useCallback(c  =>{ setForm({...EMPTY,...c,col:migrateCol(c.col),tasks:c.tasks||[],pagamentos:c.pagamentos||[]}); setModal(true); },[]);

  const save = useCallback(async()=>{
    if(!form.processo.trim()) return;
    setSaving(true);setErr(null);
    try {
      const toSave={...form,owner:form.owner||perfil};
      if(toSave.id){const u=await apiLayer.update(toSave);setCards(cs=>cs.map(c=>c.id===u.id?u:c));}
      else{const n=await apiLayer.create(toSave);setCards(cs=>[...cs,n]);}
      setModal(false);
    }catch(e){setErr(e.message);}
    setSaving(false);
  },[form,perfil]);

  const del = useCallback(async(id)=>{
    if(!window.confirm("Excluir este processo?")) return;
    setSaving(true);
    try{await apiLayer.remove(id);setCards(cs=>cs.filter(c=>c.id!==id));setModal(false);}catch(e){setErr(e.message);}
    setSaving(false);
  },[]);

  const onDrop = useCallback(colId=>{
    if(!drag) return;
    const card=cards.find(c=>c.id===drag);
    if(card&&card.col!==colId){setCards(cs=>cs.map(c=>c.id===drag?{...c,col:colId}:c));apiLayer.patchCol(drag,colId).catch(()=>load());}
    setDrag(null);setDragOver(null);
  },[drag,cards,load]);

  const filtered = useMemo(()=>cards.filter(c=>c.owner===perfil&&(!search||(c.processo+c.autor+c.reu+c.tipo).toLowerCase().includes(search.toLowerCase()))&&(!ftipo||c.tipo===ftipo)),[cards,search,ftipo,perfil]);
  const allPags  = useMemo(()=>cards.filter(c=>c.owner===perfil).flatMap(c=>c.pagamentos||[]),[cards,perfil]);
  const totalH   = useMemo(()=>cards.filter(c=>c.owner===perfil).reduce((s,c)=>s+(parseFloat(c.honorarios)||0),0),[cards,perfil]);
  const totalR   = useMemo(()=>totalPago(allPags),[allPags]);
  const now      = new Date();
  const semana   = useMemo(()=>allPags.filter(p=>new Date(p.data)>=new Date(now-7*86400000)).reduce((s,p)=>s+(parseFloat(p.valor)||0),0),[allPags]);
  const mes      = useMemo(()=>allPags.filter(p=>{const d=new Date(p.data);return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();}).reduce((s,p)=>s+(parseFloat(p.valor)||0),0),[allPags]);
  const ano      = useMemo(()=>allPags.filter(p=>new Date(p.data).getFullYear()===now.getFullYear()).reduce((s,p)=>s+(parseFloat(p.valor)||0),0),[allPags]);
  const BAR_C    = ["#3B82F6","#10B981","#D97706","#8B5CF6","#059669","#EC4899","#EF4444"];
  const byTipo   = useMemo(()=>{const m={};cards.filter(c=>c.owner===perfil).forEach(c=>{const h=parseFloat(c.honorarios)||0,r=totalPago(c.pagamentos||[]);if(!m[c.tipo])m[c.tipo]={h:0,r:0,n:0};m[c.tipo].h+=h;m[c.tipo].r+=r;m[c.tipo].n++;});return Object.entries(m).sort((a,b)=>b[1].h-a[1].h);},[cards,perfil]);
  const byTrib   = useMemo(()=>{const m={};cards.filter(c=>c.owner===perfil).forEach(c=>{const h=parseFloat(c.honorarios)||0,r=totalPago(c.pagamentos||[]);if(!m[c.tribunal])m[c.tribunal]={h:0,r:0,n:0};m[c.tribunal].h+=h;m[c.tribunal].r+=r;m[c.tribunal].n++;});return Object.entries(m).sort((a,b)=>b[1].h-a[1].h);},[cards,perfil]);

  const PERFIL_LABEL = { miguel:"Miguel", raphaella:"Raphaella" };
  const PERFIL_COR   = { miguel:"#3B82F6", raphaella:"#A855F7" };

  // ── Fluxo de telas ─────────────────────────────────────────────────────────
  if (!logado)  return <TelaLogin    onLogin={()=>setLogado(true)} />;
  if (!perfil)  return <TelaSelecao  onSelect={setPerfil} />;

  return (
    <div style={{fontFamily:"var(--font-sans)",background:"#0A0A0A",minHeight:"100vh",padding:"12px 10px",color:"#E5E7EB"}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
        <h2 style={{fontSize:16,fontWeight:500,margin:0,flex:1,color:"#F9FAFB"}}>
          Gestão Pericial
          <span style={{fontSize:12,fontWeight:400,color:PERFIL_COR[perfil],marginLeft:8,padding:"1px 8px",borderRadius:99,background:`${PERFIL_COR[perfil]}18`,border:`1px solid ${PERFIL_COR[perfil]}44`}}>
            {PERFIL_LABEL[perfil]}
          </span>
        </h2>

        {/* ── Trocar perfil ── */}
        <button onClick={()=>setPerfil(null)} style={{...s.btn("#1A1A1A","#9CA3AF","#333"),fontSize:11,padding:"3px 10px"}} title="Trocar dashboard">⇄ Trocar</button>

        {/* ── Sair do sistema ── */}
        <button onClick={handleLogout} style={{...s.btn("#1A1A1A","#EF4444","#3B1515"),fontSize:11,padding:"3px 10px"}} title="Sair do sistema">⏻ Sair</button>

        {gcalAuth
          ?<span style={{fontSize:10,padding:"2px 8px",borderRadius:5,background:"#0A2E1A",color:"#6EE7B7",border:"1px solid #064E2A",display:"flex",alignItems:"center",gap:4}}>
              <span>📅</span>{gcalAuth.email}
              <button onClick={()=>backendFetch("/auth/logout",{method:"POST"}).then(()=>setGcalAuth(null))} style={{background:"none",border:"none",color:"#6EE7B7",cursor:"pointer",fontSize:11,padding:"0 0 0 4px",opacity:.7}}>✕</button>
            </span>
          :gcalChecking
          ?<span style={{fontSize:10,padding:"2px 8px",borderRadius:5,background:"#1E3A5F",color:"#93C5FD",border:"1px solid #1D4ED8",display:"flex",alignItems:"center",gap:5}}>
              <span style={{width:8,height:8,border:"1.5px solid rgba(147,197,253,.3)",borderTopColor:"#93C5FD",borderRadius:"50%",display:"inline-block",animation:"spin .7s linear infinite"}}/>Verificando…
            </span>
          :<div style={{display:"flex",gap:5}}>
              <button onClick={loginGoogle} style={{...s.btn("#1E3A5F","#93C5FD","#1D4ED8"),fontSize:11,padding:"3px 10px",display:"flex",alignItems:"center",gap:5}}>
                <svg width="11" height="11" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
                Entrar Google
              </button>
              <button onClick={atualizarConexao} style={{...s.btn("#1A1A1A","#9CA3AF","#333"),fontSize:11,padding:"3px 8px"}} title="Verificar conexão Google">↻</button>
            </div>}
        <span style={{fontSize:10,padding:"2px 7px",borderRadius:5,background:API_BASE?"#0A2E1A":"#3B2A0A",color:API_BASE?"#6EE7B7":"#FCD34D",border:`1px solid ${API_BASE?"#064E2A":"#78350F"}`}}>{API_BASE?"API":"Local"}</span>
        <button onClick={load} disabled={loading} style={s.btn()}>↻</button>
      </div>

      {err&&<div style={{background:"#3B1515",border:"1px solid #7F1D1D",borderRadius:6,padding:"6px 12px",marginBottom:8,fontSize:11,color:"#FCA5A5",display:"flex",justifyContent:"space-between"}}><span>⚠ {err}</span><button onClick={()=>setErr(null)} style={{background:"none",border:"none",color:"#FCA5A5",cursor:"pointer"}}>✕</button></div>}

      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
        {[{l:"Honorários",v:fmt(totalH)},{l:"Recebido",v:fmt(totalR),c:"#34D399",s:totalH?`${Math.round(totalR/totalH*100)}%`:""},{l:"A receber",v:fmt(totalH-totalR),c:totalH-totalR>0?"#FBBF24":"#34D399"},{l:"Semana",v:fmt(semana),c:"#60A5FA"},{l:"Mês",v:fmt(mes),c:"#60A5FA"},{l:"Ano",v:fmt(ano),c:"#60A5FA"},{l:"Processos",v:cards.filter(c=>c.owner===perfil).length,s:`${cards.filter(c=>c.owner===perfil&&c.col==="execucao").length} exec.`}].map(m=>(
          <div key={m.l} style={{background:"#141414",border:"1px solid #1E1E1E",borderRadius:7,padding:"8px 12px",flex:"1 1 90px"}}>
            <div style={{fontSize:10,color:"#4B5563"}}>{m.l}</div>
            <div style={{fontSize:15,fontWeight:500,color:m.c||"#F3F4F6"}}>{m.v}</div>
            {m.s&&<div style={{fontSize:9,color:"#374151"}}>{m.s}</div>}
          </div>
        ))}
      </div>

      {cards.filter(c=>c.owner===perfil).length>0&&(
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
          {[{title:"Por tipo",rows:byTipo,max:byTipo[0]?.[1].h||1},{title:"Por tribunal",rows:byTrib,max:byTrib[0]?.[1].h||1}].map(({title,rows,max})=>(
            <div key={title} style={{flex:"1 1 200px",background:"#111",border:"1px solid #1E1E1E",borderRadius:8,padding:"10px 12px"}}>
              <div style={{fontSize:10,color:"#4B5563",marginBottom:6}}>{title}</div>
              {rows.map(([k,v],i)=>{const pct=Math.round(v.h/max*100),rp=v.h?Math.round(v.r/v.h*100):0;return(
                <div key={k} style={{marginBottom:7}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:2}}><span style={{color:"#D1D5DB"}}>{k}</span><span style={{color:"#4B5563"}}>{v.n} · {fmt(v.h)}</span></div>
                  <div style={{height:5,background:"#1E1E1E",borderRadius:3,overflow:"hidden",position:"relative"}}>
                    <div style={{position:"absolute",height:"100%",width:`${pct}%`,background:BAR_C[i%BAR_C.length],opacity:.2,borderRadius:3}}/>
                    <div style={{position:"absolute",height:"100%",width:`${Math.round(pct*rp/100)}%`,background:BAR_C[i%BAR_C.length],borderRadius:3}}/>
                  </div>
                </div>
              );})}
            </div>
          ))}
        </div>
      )}

      <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar processo, autor, réu…" style={{...s.inp,flex:"1 1 160px"}}/>
        <select value={ftipo} onChange={e=>setFtipo(e.target.value)} style={{...s.inp,flex:"0 0 130px"}}><option value="">Todos os tipos</option>{TIPOS.map(t=><option key={t}>{t}</option>)}</select>
      </div>

      {loading?<div style={{textAlign:"center",padding:"40px 0",color:"#374151"}}>Carregando…</div>:(
        <div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:10,alignItems:"flex-start"}}>
          {COLS.map(col=>{
            const cc=filtered.filter(c=>c.col===col.id);
            return(
              <div key={col.id} onDragOver={e=>{e.preventDefault();setDragOver(col.id);}} onDrop={()=>onDrop(col.id)} onDragLeave={()=>setDragOver(null)}
                style={{flex:"0 0 215px",background:dragOver===col.id?"#1A2030":"#0F0F0F",borderRadius:9,padding:"9px 7px",minHeight:200,border:`1px solid ${dragOver===col.id?col.color:"#1E1E1E"}`,transition:"border .15s"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                  <div style={{display:"flex",alignItems:"center",gap:5}}><span style={{width:7,height:7,borderRadius:"50%",background:col.color,display:"inline-block"}}/><span style={{fontSize:11,fontWeight:500,color:"#9CA3AF"}}>{col.label}</span></div>
                  <span style={{fontSize:10,background:"#1A1A1A",border:"1px solid #2A2A2A",borderRadius:9,padding:"1px 6px",color:"#4B5563"}}>{cc.length}</span>
                </div>
                {cc.map(card=><KanbanCard key={card.id} card={card} onClick={()=>openEdit(card)} onDragStart={()=>setDrag(card.id)}/>)}
                <button onClick={()=>openNew(col.id)} style={{width:"100%",marginTop:3,fontSize:11,padding:"5px 0",color:"#374151",background:"transparent",border:"1px dashed #1E1E1E",borderRadius:6,cursor:"pointer"}}>+ Novo</button>
              </div>
            );
          })}
        </div>
      )}

      {modal&&<ModalForm form={form} onField={onField} onSave={save} onDelete={del} onClose={()=>setModal(false)} saving={saving} gcalAuth={gcalAuth} setGcalAuth={setGcalAuth} loginGoogle={loginGoogle} gcalChecking={gcalChecking} setGcalChecking={setGcalChecking}/>}
    </div>
  );
}