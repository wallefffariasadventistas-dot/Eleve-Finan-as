import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, query, orderBy, serverTimestamp, setDoc,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-storage.js";
import {
  getFunctions, httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { firebaseConfig, FUNCTIONS_REGION } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const functions = getFunctions(app, FUNCTIONS_REGION);

const state = {
  despesas: [], relatorios: [], selecionadas: new Set(), editandoDespesaId: null,
  editandoRelatorioId: null, relatoriosExpandidos: new Set(),
  relatoriosFixos: [], notasFixas: [], editandoRelatorioFixoId: null, editandoNotaId: null,
  relatoriosFixosExpandidos: new Set(), notaFixaRelatorioAtual: null,
  compromissos: [], editandoCompromissoId: null,
  subvencoes: [], editandoSubvencaoId: null,
  departamentoExpandido: new Set(),
  pessoalExpandido: new Set(),
  compromissosExpandido: new Set(),
};

const CATEGORIA_LABEL = {
  combustivel: "Combustível", hospedagem: "Hospedagem", alimentacao: "Alimentação",
  transporte: "Transporte", carro_alugado: "Carro alugado", material: "Material",
  servicos: "Serviços", outros: "Outros",
};
const STATUS_LABEL = {
  pendente: "Pendente", enviado: "Enviado", reembolsado: "Reembolsado", nao_reembolsavel: "—",
};
// Classe de cor pro valor em R$ conforme o status — mesma leitura rápida do badge, só que no número.
const CLASSE_VALOR_STATUS = { pendente: "valor-pendente", enviado: "valor-enviado", reembolsado: "valor-recebido" };
function classeValorStatus(status) { return CLASSE_VALOR_STATUS[status] ?? ""; }
const STATUS_RELATORIO_LABEL = { aberto: "Aberto", enviado: "Enviado", pago: "Pago" };
const STATUS_RELATORIO_BADGE = { aberto: "badge-pendente", enviado: "badge-enviado", pago: "badge-reembolsado" };
const GRUPOS_TIPO_DESPESA = [
  { titulo: "Viagem", tipo: "viagem" },
  { titulo: "Departamento", tipo: "departamento" },
  { titulo: "Pessoal", tipo: "pessoal" },
];
const ICON_SVG = {
  viagem: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
  departamento: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2.5"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`,
  pessoal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/></svg>`,
  carteira: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12V8H6a2 2 0 0 1 0-4h12v4"/><path d="M4 6v12a2 2 0 0 0 2 2h14v-6"/><path d="M18 12a2 2 0 0 0 0 4h3v-4Z"/></svg>`,
  cifrao: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
};
const ORIGEM_SUBVENCAO_LABEL = { uniao: "União", campo: "Campo", projetos: "Projetos" };
const STATUS_SUBVENCAO_LABEL = { pendente: "Pendente", recebida: "Recebida" };
const STATUS_SUBVENCAO_BADGE = { pendente: "badge-pendente", recebida: "badge-reembolsado" };

function calcularReembolsavel(tipo) { return tipo === "viagem" || tipo === "departamento"; }

function mesAtualISO() {
  const hoje = new Date();
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
}

// ---------- MÁSCARA DE MOEDA (R$ 1.234,56) ----------
// Formata a partir dos dígitos digitados (os 2 últimos viram centavos), igual a um
// campo de valor de banco/maquininha — sem depender do separador decimal do navegador.
function formatarValorMoeda(valorOuDigitos) {
  const digitos = String(valorOuDigitos ?? "").replace(/\D/g, "");
  if (!digitos) return "";
  return (Number(digitos) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function preencherCampoMoeda(id, numero) {
  document.getElementById(id).value = numero == null ? "" : formatarValorMoeda(Math.round(numero * 100));
}
function lerCampoMoeda(id) {
  const bruto = document.getElementById(id).value.replace(/\./g, "").replace(",", ".").trim();
  return bruto === "" ? null : Number(bruto);
}
// Mesmo padrão brasileiro (milhar com ponto, centavos com vírgula) usado em todo R$
// exibido na tela — cards, tabelas, totais e PDFs — não só nos campos de digitação.
function formatarMoedaExibicao(numero) {
  return (numero ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
document.querySelectorAll(".input-moeda").forEach((input) => {
  input.addEventListener("input", () => {
    input.value = formatarValorMoeda(input.value);
    input.setSelectionRange(input.value.length, input.value.length);
  });
});

// Despesa de viagem cujo relatório já foi marcado como "Pago" já foi reembolsada junto com
// o relatório, mesmo que o campo statusReembolso da despesa em si ainda diga "pendente".
function estaPendenteDeReembolso(d) {
  if (d.statusReembolso !== "pendente") return false;
  if (d.tipoDespesa === "viagem" && d.relatorioViagemId) {
    const relatorio = state.relatorios.find((r) => r.id === d.relatorioViagemId);
    if (relatorio?.status === "pago") return false;
  }
  return true;
}

function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast show" + (isError ? " error" : "");
  setTimeout(() => (el.className = "toast"), 3200);
}

// Qualquer erro não tratado (ex: biblioteca de PDF que não carregou, bug de código)
// aparece como um toast visível, em vez de falhar em silêncio sem nenhum sinal na tela.
window.addEventListener("error", (e) => {
  console.error("Erro não tratado:", e.error ?? e.message);
  toast("Erro inesperado: " + (e.error?.message ?? e.message), true);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("Promise rejeitada:", e.reason);
  toast("Erro inesperado: " + (e.reason?.message ?? String(e.reason)), true);
});

// ---------- AUTH ----------
onAuthStateChanged(auth, (user) => {
  document.getElementById("login-screen").classList.toggle("show", !user);
  document.getElementById("app-shell").hidden = !user;
  if (user) startListeners();
});

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value;
  const senha = document.getElementById("login-password").value;
  try {
    await signInWithEmailAndPassword(auth, email, senha);
    document.getElementById("login-error").textContent = "";
  } catch (err) {
    document.getElementById("login-error").textContent = "E-mail ou senha inválidos.";
  }
});

document.getElementById("logout-btn").addEventListener("click", () => signOut(auth));

// ---------- NAV ----------
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".section").forEach((s) => s.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`section-${btn.dataset.section}`).classList.add("active");
  });
});

// ---------- LISTENERS ----------
function startListeners() {
  onSnapshot(query(collection(db, "despesas"), orderBy("criadoEm", "desc")), (snap) => {
    state.despesas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderDashboard();
    renderDepartamento();
    renderPessoal();
    renderRelatorios();
    // O subtotal de Compromissos Mensais soma junto as despesas pessoais do mês.
    renderCompromissos();
  });
  onSnapshot(collection(db, "relatoriosViagem"), (snap) => {
    state.relatorios = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    popularSelectRelatorios();
    renderRelatorios();
    // O total "pendente de reembolso" do Dashboard depende do status do relatório
    // (uma despesa de viagem some da contagem quando o relatório é marcado como pago).
    renderDashboard();
  });
  onSnapshot(collection(db, "relatoriosFixos"), (snap) => {
    state.relatoriosFixos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderRelatoriosFixos();
  });
  onSnapshot(collection(db, "notasFixas"), (snap) => {
    state.notasFixas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderRelatoriosFixos();
  });
  onSnapshot(collection(db, "compromissosMensais"), (snap) => {
    state.compromissos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderCompromissos();
  });
  onSnapshot(collection(db, "subvencoes"), (snap) => {
    state.subvencoes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderSubvencoes();
  });
  onSnapshot(doc(db, "configuracoes", "reembolso"), (snap) => {
    const cfg = snap.exists() ? snap.data() : {};
    document.getElementById("cfg-banco").value = cfg.banco ?? "";
    document.getElementById("cfg-conta").value = cfg.contaReembolso ?? "";
    document.getElementById("cfg-chave-pix").value = cfg.chavePix ?? "";
    document.getElementById("cfg-centro-custo").value = cfg.centroCusto ?? "";
  });
}

// ---------- DASHBOARD ----------
function renderDashboard() {
  const mesAtual = mesAtualISO();
  const totalMes = state.despesas
    .filter((d) => d.data && d.data.startsWith(mesAtual))
    .reduce((s, d) => s + (d.valor ?? 0), 0);
  const totalPendente = state.despesas
    .filter(estaPendenteDeReembolso)
    .reduce((s, d) => s + (d.valor ?? 0), 0);
  const porTipo = { viagem: 0, departamento: 0, pessoal: 0 };
  state.despesas.forEach((d) => { if (d.tipoDespesa) porTipo[d.tipoDespesa] += d.valor ?? 0; });

  document.getElementById("dashboard-hero").innerHTML = `
    <div>
      <div class="hero-balance-label">Gasto no mês</div>
      <div class="hero-balance-value">R$ ${formatarMoedaExibicao(totalMes)}</div>
    </div>
    <div class="hero-balance-icon">${ICON_SVG.carteira}</div>
  `;

  document.getElementById("dashboard-metrics").innerHTML = `
    <button type="button" class="metric-card clickable" id="metric-pendente-reembolso">
      <div class="metric-label">Pendente de reembolso</div>
      <div class="metric-value amber">R$ ${formatarMoedaExibicao(totalPendente)}</div>
      <div class="metric-hint">Ver por área →</div>
    </button>
    <div class="metric-card tipo-viagem">
      <div class="metric-icon-row"><span class="icon-badge icon-viagem">${ICON_SVG.viagem}</span><span class="metric-label">Viagem</span></div>
      <div class="metric-value">R$ ${formatarMoedaExibicao(porTipo.viagem)}</div>
    </div>
    <div class="metric-card tipo-departamento">
      <div class="metric-icon-row"><span class="icon-badge icon-departamento">${ICON_SVG.departamento}</span><span class="metric-label">Departamento</span></div>
      <div class="metric-value">R$ ${formatarMoedaExibicao(porTipo.departamento)}</div>
    </div>
    <div class="metric-card tipo-pessoal">
      <div class="metric-icon-row"><span class="icon-badge icon-pessoal">${ICON_SVG.pessoal}</span><span class="metric-label">Pessoal</span></div>
      <div class="metric-value">R$ ${formatarMoedaExibicao(porTipo.pessoal)}</div>
    </div>
  `;
  document.getElementById("metric-pendente-reembolso").addEventListener("click", abrirModalPendentes);

  const recentes = state.despesas.slice(0, 8);
  document.getElementById("dashboard-recent").innerHTML = recentes.map(linhaDespesaResumida).join("") ||
    `<p class="page-subtitle" style="padding: 18px;">Nenhum lançamento ainda.</p>`;

  if (modalPendentes.classList.contains("show")) renderPendentesModal();
}

// ---------- MODAL PENDENTE DE REEMBOLSO POR ÁREA ----------
const modalPendentes = document.getElementById("modal-pendentes");
function renderPendentesModal() {
  const pendentes = state.despesas.filter(estaPendenteDeReembolso);
  document.getElementById("pendentes-conteudo").innerHTML = GRUPOS_TIPO_DESPESA.map((grupo) => {
    const despesasGrupo = pendentes.filter((d) => d.tipoDespesa === grupo.tipo);
    if (despesasGrupo.length === 0) return "";
    const total = despesasGrupo.reduce((s, d) => s + (d.valor ?? 0), 0);
    return `
      <div class="pendentes-grupo">
        <div class="pendentes-grupo-header">
          <span class="pendentes-grupo-titulo">${grupo.titulo} · ${despesasGrupo.length} despesa(s)</span>
          <span class="pendentes-grupo-total">R$ ${formatarMoedaExibicao(total)}</span>
        </div>
        <div class="table-wrap"><table><tbody>${despesasGrupo.map(linhaDespesaSimples).join("")}</tbody></table></div>
      </div>`;
  }).join("") || `<p class="page-subtitle">Nenhuma despesa pendente de reembolso.</p>`;
}
function abrirModalPendentes() {
  renderPendentesModal();
  modalPendentes.classList.add("show");
}
document.getElementById("btn-fechar-pendentes").addEventListener("click", () => modalPendentes.classList.remove("show"));

function linhaDespesaSimples(d) {
  return `<tr>
    <td data-label="Data">${d.data ?? "—"}</td>
    <td data-label="Descrição">${d.descricao ?? ""}</td>
    <td data-label="Categoria">${CATEGORIA_LABEL[d.categoria] ?? d.categoria}</td>
    <td data-label="Tipo">${d.tipoDespesa ?? "—"}</td>
    <td data-label="Valor" class="td-mono ${classeValorStatus(d.statusReembolso)}">R$ ${formatarMoedaExibicao((d.valor ?? 0))}</td>
    <td data-label="Ações">${botoesAcaoDespesa(d)}</td>
  </tr>`;
}

// Versão enxuta usada só nos "Últimos lançamentos" do Dashboard — sem tabela nem
// botões de ação, só o essencial pra dar uma visão geral rápida e limpa.
function linhaDespesaResumida(d) {
  const meta = [CATEGORIA_LABEL[d.categoria] ?? d.categoria, d.data].filter(Boolean).join(" · ");
  const icone = ICON_SVG[d.tipoDespesa] ?? ICON_SVG.cifrao;
  return `
    <div class="lancamento-linha">
      <span class="icon-badge">${icone}</span>
      <div class="lancamento-info">
        <div class="lancamento-desc">${d.descricao || "—"}</div>
        <div class="lancamento-meta">${meta}</div>
      </div>
      <div class="lancamento-valor ${classeValorStatus(d.statusReembolso)}">R$ ${formatarMoedaExibicao(d.valor ?? 0)}</div>
    </div>`;
}

// ---------- AÇÕES COMPARTILHADAS (ver recibo / editar / excluir) ----------
// Junta o comprovante principal com os extras (quando várias fotos/PDFs vieram juntos
// pelo Telegram pra mesma despesa) numa lista só.
function recibosDe(d) {
  const lista = [];
  if (d.comprovanteStoragePath) lista.push(d.comprovanteStoragePath);
  if (Array.isArray(d.comprovantesExtras)) lista.push(...d.comprovantesExtras);
  return lista;
}

function botoesAcaoDespesa(d) {
  const recibos = recibosDe(d);
  return `<div class="row-actions">
    ${recibos.length ? `<button class="btn btn-sm" data-ver-comprovante="${d.id}">Ver recibo${recibos.length > 1 ? ` (${recibos.length})` : ""}</button>` : ""}
    <button class="btn btn-sm" data-editar-despesa="${d.id}">Editar</button>
    <button class="btn btn-sm btn-danger" data-excluir-despesa="${d.id}">Excluir</button>
  </div>`;
}

async function abrirReciboUnico(storagePath) {
  const janela = window.open("", "_blank");
  try {
    const url = await getDownloadURL(ref(storage, storagePath));
    if (janela) janela.location.href = url;
  } catch (err) {
    if (janela) janela.close();
    toast("Erro ao abrir comprovante: " + err.message, true);
  }
}

const modalRecibos = document.getElementById("modal-recibos");
function abrirModalRecibos(d, recibos) {
  document.getElementById("modal-recibos-titulo").textContent = d.descricao || "Comprovantes";
  document.getElementById("recibos-lista").innerHTML = recibos
    .map((_, i) => `<button type="button" class="btn" data-recibo-index="${i}">Recibo ${i + 1}</button>`)
    .join("");
  document.querySelectorAll("#recibos-lista [data-recibo-index]").forEach((btn) => {
    btn.addEventListener("click", () => abrirReciboUnico(recibos[Number(btn.dataset.reciboIndex)]));
  });
  modalRecibos.classList.add("show");
}
document.getElementById("btn-fechar-recibos").addEventListener("click", () => modalRecibos.classList.remove("show"));
[modalRecibos].forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.querySelector(".modal-close").click();
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (modalRecibos.classList.contains("show")) document.getElementById("btn-fechar-recibos").click();
});

// Delegação de evento num único listener fixo em document: as tabelas de despesas são
// recriadas via innerHTML toda vez que qualquer despesa muda em qualquer área do sistema,
// então anexar um listener por botão a cada render duplicava listeners (múltiplos "Excluir?"
// no mesmo clique). Delegar em document resolve isso de vez, não importa quantas vezes o
// conteúdo é substituído.
document.addEventListener("click", async (e) => {
  const verBtn = e.target.closest("[data-ver-comprovante]");
  if (verBtn) {
    e.stopPropagation();
    const d = state.despesas.find((x) => x.id === verBtn.dataset.verComprovante);
    if (!d) return;
    const recibos = recibosDe(d);
    if (recibos.length === 0) return;
    if (recibos.length === 1) {
      // Continua abrindo direto quando só tem um — sem passo extra de clicar numa lista.
      abrirReciboUnico(recibos[0]);
    } else {
      // Vários comprovantes: cada um precisa do próprio clique do usuário pra abrir a aba
      // (senão o navegador bloqueia como pop-up depois do segundo window.open seguido).
      abrirModalRecibos(d, recibos);
    }
    return;
  }

  const editarBtn = e.target.closest("[data-editar-despesa]");
  if (editarBtn) {
    e.stopPropagation();
    const d = state.despesas.find((x) => x.id === editarBtn.dataset.editarDespesa);
    if (d) abrirModalDespesaEdicao(d);
    return;
  }

  const excluirBtn = e.target.closest("[data-excluir-despesa]");
  if (excluirBtn) {
    e.stopPropagation();
    if (!confirm("Excluir esta despesa? Essa ação não pode ser desfeita.")) return;
    try {
      await deleteDoc(doc(db, "despesas", excluirBtn.dataset.excluirDespesa));
      toast("Despesa excluída.");
    } catch (err) {
      toast("Erro ao excluir despesa: " + err.message, true);
    }
    return;
  }

  const verNotaBtn = e.target.closest("[data-ver-nota]");
  if (verNotaBtn) {
    e.stopPropagation();
    const n = state.notasFixas.find((x) => x.id === verNotaBtn.dataset.verNota);
    if (!n) return;
    const recibos = recibosDe(n);
    if (recibos.length === 0) return;
    if (recibos.length === 1) {
      abrirReciboUnico(recibos[0]);
    } else {
      abrirModalRecibos(n, recibos);
    }
    return;
  }

  const editarNotaBtn = e.target.closest("[data-editar-nota]");
  if (editarNotaBtn) {
    e.stopPropagation();
    const n = state.notasFixas.find((x) => x.id === editarNotaBtn.dataset.editarNota);
    if (n) abrirModalNotaFixaEdicao(n);
    return;
  }

  const excluirNotaBtn = e.target.closest("[data-excluir-nota]");
  if (excluirNotaBtn) {
    e.stopPropagation();
    if (!confirm("Excluir esta nota? Essa ação não pode ser desfeita.")) return;
    try {
      await deleteDoc(doc(db, "notasFixas", excluirNotaBtn.dataset.excluirNota));
      toast("Nota excluída.");
    } catch (err) {
      toast("Erro ao excluir nota: " + err.message, true);
    }
  }
});

function renderDepartamento() {
  const status = document.getElementById("filtro-status-departamento").value;
  const filtradas = state.despesas.filter((d) =>
    d.tipoDespesa === "departamento" && (!status || d.statusReembolso === status)
  );

  document.getElementById("lista-departamento").innerHTML = filtradas.map((d) => {
    const meta = [CATEGORIA_LABEL[d.categoria] ?? d.categoria, d.data].filter(Boolean).join(" · ");
    return `
      <div class="despesa-card">
        <div class="despesa-card-header" data-toggle-despesa="${d.id}">
          <input type="checkbox" class="chk-despesa" data-id="${d.id}" ${d.statusReembolso === "pendente" ? "" : "disabled"} />
          <span class="icon-badge">${ICON_SVG.departamento}</span>
          <div class="despesa-card-info">
            <div class="despesa-card-desc">${d.descricao || "—"}</div>
            <div class="despesa-card-meta">${meta}</div>
          </div>
          <span class="badge badge-${d.statusReembolso}">${STATUS_LABEL[d.statusReembolso] ?? d.statusReembolso}</span>
          <div class="despesa-card-valor ${classeValorStatus(d.statusReembolso)}">R$ ${formatarMoedaExibicao(d.valor ?? 0)}</div>
        </div>
        <div class="despesa-card-body${state.departamentoExpandido.has(d.id) ? " open" : ""}" id="despesa-body-${d.id}">
          <div class="despesa-card-detalhe"><span>Origem</span><span>${d.origem ?? "—"}</span></div>
          <div class="row-actions">
            ${(d.statusReembolso === "pendente" || d.statusReembolso === "enviado") ? `<button class="btn btn-sm btn-primary" data-marcar-reembolsado="${d.id}">✅ Marcar como reembolsado</button>` : ""}
            ${botoesAcaoDespesa(d)}
          </div>
        </div>
      </div>`;
  }).join("") || `<p class="page-subtitle" style="padding: 18px;">Nenhuma despesa de departamento lançada ainda.</p>`;

  document.querySelectorAll("#lista-departamento [data-marcar-reembolsado]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await updateDoc(doc(db, "despesas", btn.dataset.marcarReembolsado), {
          statusReembolso: "reembolsado",
          atualizadoEm: serverTimestamp(),
        });
        toast("Despesa marcada como reembolsada.");
      } catch (err) {
        toast("Erro ao marcar como reembolsado: " + err.message, true);
      }
    });
  });
  document.querySelectorAll("#lista-departamento .chk-despesa").forEach((chk) => {
    chk.addEventListener("click", (e) => e.stopPropagation());
    chk.addEventListener("change", () => {
      chk.checked ? state.selecionadas.add(chk.dataset.id) : state.selecionadas.delete(chk.dataset.id);
    });
  });
  document.querySelectorAll("#lista-departamento [data-toggle-despesa]").forEach((header) => {
    header.addEventListener("click", () => {
      const id = header.dataset.toggleDespesa;
      state.departamentoExpandido.has(id) ? state.departamentoExpandido.delete(id) : state.departamentoExpandido.add(id);
      document.getElementById(`despesa-body-${id}`).classList.toggle("open");
    });
  });
}
document.getElementById("filtro-status-departamento").addEventListener("change", renderDepartamento);

// ---------- DESPESAS PESSOAIS ----------
function renderPessoal() {
  const filtradas = state.despesas.filter((d) => d.tipoDespesa === "pessoal");

  document.getElementById("lista-pessoal").innerHTML = filtradas.map((d) => {
    const meta = [CATEGORIA_LABEL[d.categoria] ?? d.categoria, d.data].filter(Boolean).join(" · ");
    return `
      <div class="despesa-card">
        <div class="despesa-card-header" data-toggle-despesa="${d.id}">
          <span class="icon-badge">${ICON_SVG.pessoal}</span>
          <div class="despesa-card-info">
            <div class="despesa-card-desc">${d.descricao || "—"}</div>
            <div class="despesa-card-meta">${meta}</div>
          </div>
          <div class="despesa-card-valor">R$ ${formatarMoedaExibicao(d.valor ?? 0)}</div>
        </div>
        <div class="despesa-card-body${state.pessoalExpandido.has(d.id) ? " open" : ""}" id="pessoal-body-${d.id}">
          <div class="despesa-card-detalhe"><span>Origem</span><span>${d.origem ?? "—"}</span></div>
          <div class="row-actions">${botoesAcaoDespesa(d)}</div>
        </div>
      </div>`;
  }).join("") || `<p class="page-subtitle" style="padding: 18px;">Nenhuma despesa pessoal lançada ainda.</p>`;

  document.querySelectorAll("#lista-pessoal [data-toggle-despesa]").forEach((header) => {
    header.addEventListener("click", () => {
      const id = header.dataset.toggleDespesa;
      state.pessoalExpandido.has(id) ? state.pessoalExpandido.delete(id) : state.pessoalExpandido.add(id);
      document.getElementById(`pessoal-body-${id}`).classList.toggle("open");
    });
  });
}

// ---------- MODAL DESPESA (lançamento manual) ----------
const modalDespesa = document.getElementById("modal-despesa");

function abrirModalDespesa(tipoPreset) {
  state.editandoDespesaId = null;
  document.getElementById("form-despesa").reset();
  document.getElementById("modal-despesa-eyebrow").textContent = "Lançamento manual";
  document.getElementById("modal-despesa-titulo").textContent = "Nova despesa";
  document.getElementById("btn-salvar-despesa").textContent = "Salvar";
  document.getElementById("d-data").value = new Date().toISOString().slice(0, 10);
  if (tipoPreset) document.getElementById("d-tipo").value = tipoPreset;
  toggleCampoRelatorio();
  modalDespesa.classList.add("show");
}
document.getElementById("btn-nova-despesa-viagem").addEventListener("click", () => {
  if (!state.relatorios.some((r) => r.status === "aberto")) {
    toast("Crie um relatório de viagem antes de lançar uma despesa.", true);
    return;
  }
  abrirModalDespesa("viagem");
});
document.getElementById("btn-nova-despesa-departamento").addEventListener("click", () => abrirModalDespesa("departamento"));
document.getElementById("btn-nova-despesa-pessoal").addEventListener("click", () => abrirModalDespesa("pessoal"));

function abrirModalDespesaEdicao(d) {
  state.editandoDespesaId = d.id;
  document.getElementById("form-despesa").reset();
  document.getElementById("modal-despesa-eyebrow").textContent = "Editar lançamento";
  document.getElementById("modal-despesa-titulo").textContent = "Editar despesa";
  document.getElementById("btn-salvar-despesa").textContent = "Salvar alterações";
  document.getElementById("d-data").value = d.data ?? "";
  preencherCampoMoeda("d-valor", d.valor);
  document.getElementById("d-categoria").value = d.categoria ?? "outros";
  document.getElementById("d-tipo").value = d.tipoDespesa ?? "pessoal";
  document.getElementById("d-descricao").value = d.descricao ?? "";
  toggleCampoRelatorio();
  if (d.tipoDespesa === "viagem" && d.relatorioViagemId) {
    const select = document.getElementById("d-relatorio");
    if (!select.querySelector(`option[value="${d.relatorioViagemId}"]`)) {
      // O relatório pode já não estar mais "aberto" (não listado por padrão) — adiciona
      // pra não perder o vínculo ao editar, mostrando o status atual.
      const relatorio = state.relatorios.find((r) => r.id === d.relatorioViagemId);
      const opt = document.createElement("option");
      opt.value = d.relatorioViagemId;
      opt.textContent = relatorio ? `${relatorio.nome} (${STATUS_RELATORIO_LABEL[relatorio.status]})` : "Relatório";
      select.appendChild(opt);
    }
    select.value = d.relatorioViagemId;
  }
  modalDespesa.classList.add("show");
}

document.getElementById("btn-cancelar-despesa").addEventListener("click", () => {
  state.editandoDespesaId = null;
  modalDespesa.classList.remove("show");
});
document.getElementById("btn-fechar-despesa").addEventListener("click", () => {
  document.getElementById("btn-cancelar-despesa").click();
});
document.getElementById("d-tipo").addEventListener("change", toggleCampoRelatorio);

function toggleCampoRelatorio() {
  const isViagem = document.getElementById("d-tipo").value === "viagem";
  document.getElementById("campo-relatorio").hidden = !isViagem;
}

function popularSelectRelatorios() {
  const abertos = state.relatorios.filter((r) => r.status === "aberto");
  document.getElementById("d-relatorio").innerHTML = abertos.map((r) => `<option value="${r.id}">${r.nome}</option>`).join("");
}

document.getElementById("form-despesa").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btnSalvar = document.getElementById("btn-salvar-despesa");
  if (btnSalvar.disabled) return; // já está salvando — ignora cliques repetidos
  const textoOriginal = btnSalvar.textContent;
  btnSalvar.disabled = true;
  btnSalvar.textContent = "Salvando...";

  const tipoDespesa = document.getElementById("d-tipo").value;
  const reembolsavel = calcularReembolsavel(tipoDespesa);
  const editandoId = state.editandoDespesaId;
  const despesaAtual = editandoId ? state.despesas.find((d) => d.id === editandoId) : null;

  let statusReembolso;
  if (!reembolsavel) statusReembolso = "nao_reembolsavel";
  else if (despesaAtual && despesaAtual.reembolsavel) statusReembolso = despesaAtual.statusReembolso;
  else statusReembolso = "pendente";

  const payload = {
    data: document.getElementById("d-data").value,
    valor: lerCampoMoeda("d-valor"),
    categoria: document.getElementById("d-categoria").value,
    tipoDespesa,
    descricao: document.getElementById("d-descricao").value,
    reembolsavel,
    statusReembolso,
    relatorioViagemId: tipoDespesa === "viagem" ? (document.getElementById("d-relatorio").value || null) : null,
    atualizadoEm: serverTimestamp(),
  };

  try {
    let despesaId = editandoId;
    if (editandoId) {
      await updateDoc(doc(db, "despesas", editandoId), payload);
    } else {
      const docRef = await addDoc(collection(db, "despesas"), {
        ...payload,
        estabelecimento: null,
        finalizado: true,
        origem: "manual",
        comprovanteStoragePath: null,
        criadoEm: serverTimestamp(),
      });
      despesaId = docRef.id;
    }

    const arquivo = document.getElementById("d-comprovante").files[0];
    if (arquivo) {
      const path = `recibos/${despesaId}/original.${arquivo.name.split(".").pop()}`;
      await uploadBytes(ref(storage, path), arquivo);
      await updateDoc(doc(db, "despesas", despesaId), { comprovanteStoragePath: path });
    }

    state.editandoDespesaId = null;
    modalDespesa.classList.remove("show");
    toast(editandoId ? "Despesa atualizada com sucesso." : "Despesa lançada com sucesso.");
  } catch (err) {
    toast("Erro ao salvar despesa: " + err.message, true);
  } finally {
    btnSalvar.disabled = false;
    btnSalvar.textContent = textoOriginal;
  }
});

// ---------- MODAL RELATÓRIO ----------
const modalRelatorio = document.getElementById("modal-relatorio");
document.getElementById("btn-novo-relatorio").addEventListener("click", () => {
  state.editandoRelatorioId = null;
  document.getElementById("form-relatorio").reset();
  document.getElementById("modal-relatorio-eyebrow").textContent = "Viagem";
  document.getElementById("modal-relatorio-titulo").textContent = "Novo relatório de viagem";
  document.getElementById("btn-salvar-relatorio").textContent = "Criar";
  modalRelatorio.classList.add("show");
});
function abrirModalRelatorioEdicao(r) {
  state.editandoRelatorioId = r.id;
  document.getElementById("form-relatorio").reset();
  document.getElementById("modal-relatorio-eyebrow").textContent = "Editar";
  document.getElementById("modal-relatorio-titulo").textContent = "Editar relatório de viagem";
  document.getElementById("btn-salvar-relatorio").textContent = "Salvar alterações";
  document.getElementById("r-nome").value = r.nome ?? "";
  document.getElementById("r-destino").value = r.destino ?? "";
  document.getElementById("r-data-inicio").value = r.dataInicio ?? "";
  document.getElementById("r-data-fim").value = r.dataFim ?? "";
  modalRelatorio.classList.add("show");
}
document.getElementById("btn-cancelar-relatorio").addEventListener("click", () => {
  state.editandoRelatorioId = null;
  modalRelatorio.classList.remove("show");
});
document.getElementById("btn-fechar-relatorio").addEventListener("click", () => {
  document.getElementById("btn-cancelar-relatorio").click();
});
document.getElementById("form-relatorio").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btnSalvar = document.getElementById("btn-salvar-relatorio");
  if (btnSalvar.disabled) return;
  const editandoId = state.editandoRelatorioId;
  const textoOriginal = btnSalvar.textContent;
  btnSalvar.disabled = true;
  btnSalvar.textContent = editandoId ? "Salvando..." : "Criando...";
  try {
    const payload = {
      nome: document.getElementById("r-nome").value,
      destino: document.getElementById("r-destino").value || null,
      dataInicio: document.getElementById("r-data-inicio").value || null,
      dataFim: document.getElementById("r-data-fim").value || null,
    };
    if (editandoId) {
      await updateDoc(doc(db, "relatoriosViagem", editandoId), payload);
    } else {
      await addDoc(collection(db, "relatoriosViagem"), { ...payload, status: "aberto", criadoEm: serverTimestamp() });
    }
    state.editandoRelatorioId = null;
    modalRelatorio.classList.remove("show");
    toast(editandoId ? "Relatório de viagem atualizado." : "Relatório de viagem criado.");
  } catch (err) {
    toast("Erro ao salvar relatório: " + err.message, true);
  } finally {
    btnSalvar.disabled = false;
    btnSalvar.textContent = textoOriginal;
  }
});

// Fecha ao clicar fora da caixa (no fundo escurecido) ou apertando Esc
[modalDespesa, modalRelatorio, modalPendentes].forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.querySelector(".modal-close").click();
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (modalDespesa.classList.contains("show")) document.getElementById("btn-fechar-despesa").click();
  else if (modalRelatorio.classList.contains("show")) document.getElementById("btn-fechar-relatorio").click();
  else if (modalPendentes.classList.contains("show")) document.getElementById("btn-fechar-pendentes").click();
});

// ---------- RELATÓRIOS DE VIAGEM ----------
function formatarPeriodo(r) {
  if (r.dataInicio && r.dataFim) return `${r.dataInicio} a ${r.dataFim}`;
  if (r.dataInicio) return `a partir de ${r.dataInicio}`;
  if (r.dataFim) return `até ${r.dataFim}`;
  return "";
}

function renderRelatorios() {
  const temRelatorioAberto = state.relatorios.some((r) => r.status === "aberto");
  const btnNovaDespesaViagem = document.getElementById("btn-nova-despesa-viagem");
  btnNovaDespesaViagem.disabled = !temRelatorioAberto;
  btnNovaDespesaViagem.title = temRelatorioAberto ? "" : "Crie um relatório de viagem antes de lançar uma despesa";

  document.getElementById("lista-relatorios").innerHTML = state.relatorios.map((r) => {
    const despesasDoRelatorio = state.despesas.filter((d) => d.relatorioViagemId === r.id);
    const total = despesasDoRelatorio.reduce((s, d) => s + (d.valor ?? 0), 0);
    const meta = [r.destino, formatarPeriodo(r), `${despesasDoRelatorio.length} despesa(s)`].filter(Boolean).join(" · ");
    return `
      <div class="relatorio-card">
        <div class="relatorio-header" data-toggle="${r.id}">
          <div>
            <div class="relatorio-nome">
              ${r.nome}
              <span class="badge ${STATUS_RELATORIO_BADGE[r.status]}">${STATUS_RELATORIO_LABEL[r.status]}</span>
            </div>
            <div class="relatorio-meta">${meta}</div>
          </div>
          <div class="relatorio-total">R$ ${formatarMoedaExibicao(total)}</div>
        </div>
        <div class="relatorio-body${state.relatoriosExpandidos.has(r.id) ? " open" : ""}" id="body-${r.id}">
          <div class="rstatus-row">
            <span class="rstatus-label">Status do relatório</span>
            <div class="rstatus-toggle">
              <button data-status-relatorio="${r.id}" data-status="aberto" class="${r.status === "aberto" ? "active-aberto" : ""}">Aberto</button>
              <button data-status-relatorio="${r.id}" data-status="enviado" class="${r.status === "enviado" ? "active-enviado" : ""}">Enviado</button>
              <button data-status-relatorio="${r.id}" data-status="pago" class="${r.status === "pago" ? "active-pago" : ""}">Pago</button>
            </div>
          </div>
          <div class="table-wrap"><table><tbody>${despesasDoRelatorio.map(linhaDespesaSimples).join("") || "<tr><td>Nenhuma despesa ainda.</td></tr>"}</tbody></table></div>
          <div class="form-actions">
            <button class="btn btn-sm btn-primary" data-pdf-relatorio="${r.id}">Baixar PDF detalhado</button>
            <button class="btn btn-sm" data-comprovantes-relatorio="${r.id}">Baixar comprovantes (.zip)</button>
            <button class="btn btn-sm" data-editar-relatorio="${r.id}">Editar relatório</button>
            <button class="btn btn-sm btn-danger" data-excluir-relatorio="${r.id}">Excluir relatório</button>
          </div>
        </div>
      </div>`;
  }).join("") || `<p class="page-subtitle">Nenhum relatório de viagem ainda.</p>`;

  document.querySelectorAll("[data-toggle]").forEach((h) => {
    h.addEventListener("click", () => {
      const id = h.dataset.toggle;
      state.relatoriosExpandidos.has(id) ? state.relatoriosExpandidos.delete(id) : state.relatoriosExpandidos.add(id);
      document.getElementById(`body-${id}`).classList.toggle("open");
    });
  });
  document.querySelectorAll("[data-status-relatorio]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const novoStatus = btn.dataset.status;
      await updateDoc(doc(db, "relatoriosViagem", btn.dataset.statusRelatorio), { status: novoStatus });
      toast(`Relatório marcado como "${STATUS_RELATORIO_LABEL[novoStatus]}".`);
    });
  });
  document.querySelectorAll("[data-pdf-relatorio]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const relatorio = state.relatorios.find((r) => r.id === btn.dataset.pdfRelatorio);
      if (relatorio) baixarPdfRelatorio(relatorio);
    });
  });
  document.querySelectorAll("[data-comprovantes-relatorio]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const relatorioId = btn.dataset.comprovantesRelatorio;
      const relatorio = state.relatorios.find((r) => r.id === relatorioId);
      const despesasDoRelatorio = state.despesas.filter((d) => d.relatorioViagemId === relatorioId);
      baixarComprovantesZip(despesasDoRelatorio, `comprovantes-${relatorio?.nome ?? relatorioId}`);
    });
  });
  document.querySelectorAll("[data-editar-relatorio]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const relatorio = state.relatorios.find((r) => r.id === btn.dataset.editarRelatorio);
      if (relatorio) abrirModalRelatorioEdicao(relatorio);
    });
  });
  document.querySelectorAll("[data-excluir-relatorio]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const relatorioId = btn.dataset.excluirRelatorio;
      const despesasDoRelatorio = state.despesas.filter((d) => d.relatorioViagemId === relatorioId);
      const aviso = despesasDoRelatorio.length > 0
        ? `Excluir este relatório também vai excluir as ${despesasDoRelatorio.length} despesa(s) lançadas nele. Essa ação não pode ser desfeita. Continuar?`
        : "Excluir este relatório de viagem? Essa ação não pode ser desfeita.";
      if (!confirm(aviso)) return;
      try {
        await Promise.all(despesasDoRelatorio.map((d) => deleteDoc(doc(db, "despesas", d.id))));
        await deleteDoc(doc(db, "relatoriosViagem", relatorioId));
        toast("Relatório de viagem excluído.");
      } catch (err) {
        toast("Erro ao excluir relatório: " + err.message, true);
      }
    });
  });
}

// ---------- RELATÓRIO FIXO MENSAL ----------
const MESES_PT = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
function nomeMesAtual() {
  const hoje = new Date();
  return `${MESES_PT[hoje.getMonth()]} ${hoje.getFullYear()}`;
}

function linhaNotaFixa(n) {
  return `<tr>
    <td data-label="Data">${n.data ?? "—"}</td>
    <td data-label="Descrição">${n.descricao ?? "—"}</td>
    <td data-label="Valor" class="td-mono">${n.valor != null ? `R$ ${formatarMoedaExibicao(n.valor)}` : "—"}</td>
    <td data-label="Ações">${botoesAcaoNotaFixa(n)}</td>
  </tr>`;
}
function botoesAcaoNotaFixa(n) {
  const recibos = recibosDe(n);
  return `<div class="row-actions">
    ${recibos.length ? `<button class="btn btn-sm" data-ver-nota="${n.id}">Ver arquivo${recibos.length > 1 ? ` (${recibos.length})` : ""}</button>` : ""}
    <button class="btn btn-sm" data-editar-nota="${n.id}">Editar</button>
    <button class="btn btn-sm btn-danger" data-excluir-nota="${n.id}">Excluir</button>
  </div>`;
}

function renderRelatoriosFixos() {
  document.getElementById("lista-relatorios-fixos").innerHTML = state.relatoriosFixos.map((r) => {
    const notasDoRelatorio = state.notasFixas.filter((n) => n.relatorioFixoId === r.id);
    const total = notasDoRelatorio.reduce((s, n) => s + (n.valor ?? 0), 0);
    const semValor = notasDoRelatorio.filter((n) => n.valor == null).length;
    const meta = [`${notasDoRelatorio.length} nota(s)`, semValor > 0 ? `${semValor} sem valor lançado` : null]
      .filter(Boolean).join(" · ");
    return `
      <div class="relatorio-card">
        <div class="relatorio-header" data-toggle-fixo="${r.id}">
          <div>
            <div class="relatorio-nome">${r.nome}</div>
            <div class="relatorio-meta">${meta}</div>
          </div>
          <div class="relatorio-total">R$ ${formatarMoedaExibicao(total)}</div>
        </div>
        <div class="relatorio-body${state.relatoriosFixosExpandidos.has(r.id) ? " open" : ""}" id="body-fixo-${r.id}">
          <div class="table-wrap"><table><tbody>${notasDoRelatorio.map(linhaNotaFixa).join("") || "<tr><td>Nenhuma nota adicionada ainda.</td></tr>"}</tbody></table></div>
          <div class="form-actions">
            <button class="btn btn-sm btn-primary" data-add-nota-fixo="${r.id}">+ Adicionar nota</button>
            <button class="btn btn-sm" data-pdf-relatorio-fixo="${r.id}">Baixar PDF detalhado</button>
            <button class="btn btn-sm" data-comprovantes-relatorio-fixo="${r.id}">Baixar comprovantes (.zip)</button>
            <button class="btn btn-sm" data-editar-relatorio-fixo="${r.id}">Editar relatório</button>
            <button class="btn btn-sm btn-danger" data-excluir-relatorio-fixo="${r.id}">Excluir relatório</button>
          </div>
        </div>
      </div>`;
  }).join("") || `<p class="page-subtitle">Nenhum relatório fixo mensal criado ainda.</p>`;

  document.querySelectorAll("[data-toggle-fixo]").forEach((h) => {
    h.addEventListener("click", () => {
      const id = h.dataset.toggleFixo;
      state.relatoriosFixosExpandidos.has(id) ? state.relatoriosFixosExpandidos.delete(id) : state.relatoriosFixosExpandidos.add(id);
      document.getElementById(`body-fixo-${id}`).classList.toggle("open");
    });
  });
  document.querySelectorAll("[data-add-nota-fixo]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      abrirModalNotaFixa(btn.dataset.addNotaFixo);
    });
  });
  document.querySelectorAll("[data-pdf-relatorio-fixo]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const relatorio = state.relatoriosFixos.find((r) => r.id === btn.dataset.pdfRelatorioFixo);
      if (relatorio) baixarPdfRelatorioFixo(relatorio);
    });
  });
  document.querySelectorAll("[data-comprovantes-relatorio-fixo]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const relatorioId = btn.dataset.comprovantesRelatorioFixo;
      const relatorio = state.relatoriosFixos.find((r) => r.id === relatorioId);
      const notasDoRelatorio = state.notasFixas.filter((n) => n.relatorioFixoId === relatorioId);
      baixarComprovantesZip(notasDoRelatorio, `notas-${relatorio?.nome ?? relatorioId}`);
    });
  });
  document.querySelectorAll("[data-editar-relatorio-fixo]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const relatorio = state.relatoriosFixos.find((r) => r.id === btn.dataset.editarRelatorioFixo);
      if (relatorio) abrirModalRelatorioFixoEdicao(relatorio);
    });
  });
  document.querySelectorAll("[data-excluir-relatorio-fixo]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const relatorioId = btn.dataset.excluirRelatorioFixo;
      const notasDoRelatorio = state.notasFixas.filter((n) => n.relatorioFixoId === relatorioId);
      const aviso = notasDoRelatorio.length > 0
        ? `Excluir este relatório também vai excluir as ${notasDoRelatorio.length} nota(s) guardadas nele. Essa ação não pode ser desfeita. Continuar?`
        : "Excluir este relatório fixo mensal? Essa ação não pode ser desfeita.";
      if (!confirm(aviso)) return;
      try {
        await Promise.all(notasDoRelatorio.map((n) => deleteDoc(doc(db, "notasFixas", n.id))));
        await deleteDoc(doc(db, "relatoriosFixos", relatorioId));
        toast("Relatório fixo mensal excluído.");
      } catch (err) {
        toast("Erro ao excluir relatório: " + err.message, true);
      }
    });
  });
}

const modalRelatorioFixo = document.getElementById("modal-relatorio-fixo");
document.getElementById("btn-novo-relatorio-fixo").addEventListener("click", () => {
  state.editandoRelatorioFixoId = null;
  document.getElementById("form-relatorio-fixo").reset();
  document.getElementById("modal-relatorio-fixo-eyebrow").textContent = "Relatório Fixo Mensal";
  document.getElementById("modal-relatorio-fixo-titulo").textContent = "Novo relatório fixo mensal";
  document.getElementById("btn-salvar-relatorio-fixo").textContent = "Criar";
  document.getElementById("rf-nome").value = nomeMesAtual();
  modalRelatorioFixo.classList.add("show");
});
function abrirModalRelatorioFixoEdicao(r) {
  state.editandoRelatorioFixoId = r.id;
  document.getElementById("form-relatorio-fixo").reset();
  document.getElementById("modal-relatorio-fixo-eyebrow").textContent = "Editar";
  document.getElementById("modal-relatorio-fixo-titulo").textContent = "Editar relatório fixo mensal";
  document.getElementById("btn-salvar-relatorio-fixo").textContent = "Salvar alterações";
  document.getElementById("rf-nome").value = r.nome ?? "";
  modalRelatorioFixo.classList.add("show");
}
document.getElementById("btn-cancelar-relatorio-fixo").addEventListener("click", () => {
  state.editandoRelatorioFixoId = null;
  modalRelatorioFixo.classList.remove("show");
});
document.getElementById("btn-fechar-relatorio-fixo").addEventListener("click", () => {
  document.getElementById("btn-cancelar-relatorio-fixo").click();
});
document.getElementById("form-relatorio-fixo").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btnSalvar = document.getElementById("btn-salvar-relatorio-fixo");
  if (btnSalvar.disabled) return;
  const editandoId = state.editandoRelatorioFixoId;
  const textoOriginal = btnSalvar.textContent;
  btnSalvar.disabled = true;
  btnSalvar.textContent = editandoId ? "Salvando..." : "Criando...";
  try {
    const payload = { nome: document.getElementById("rf-nome").value };
    if (editandoId) {
      await updateDoc(doc(db, "relatoriosFixos", editandoId), payload);
    } else {
      await addDoc(collection(db, "relatoriosFixos"), { ...payload, criadoEm: serverTimestamp() });
    }
    state.editandoRelatorioFixoId = null;
    modalRelatorioFixo.classList.remove("show");
    toast(editandoId ? "Relatório fixo atualizado." : "Relatório fixo mensal criado.");
  } catch (err) {
    toast("Erro ao salvar relatório: " + err.message, true);
  } finally {
    btnSalvar.disabled = false;
    btnSalvar.textContent = textoOriginal;
  }
});

// ---------- MODAL NOTA FIXA ----------
const modalNotaFixa = document.getElementById("modal-nota-fixa");
const extrairValorNota = httpsCallable(functions, "extrairValorNota");

function abrirModalNotaFixa(relatorioFixoId) {
  state.editandoNotaId = null;
  state.notaFixaRelatorioAtual = relatorioFixoId;
  document.getElementById("form-nota-fixa").reset();
  document.getElementById("modal-nota-fixa-eyebrow").textContent = "Relatório Fixo Mensal";
  document.getElementById("modal-nota-fixa-titulo").textContent = "Nova nota";
  document.getElementById("btn-salvar-nota-fixa").textContent = "Salvar";
  document.getElementById("nf-arquivo-atual").hidden = true;
  document.getElementById("nf-data").value = new Date().toISOString().slice(0, 10);
  modalNotaFixa.classList.add("show");
}
function abrirModalNotaFixaEdicao(n) {
  state.editandoNotaId = n.id;
  state.notaFixaRelatorioAtual = n.relatorioFixoId;
  document.getElementById("form-nota-fixa").reset();
  document.getElementById("modal-nota-fixa-eyebrow").textContent = "Editar";
  document.getElementById("modal-nota-fixa-titulo").textContent = "Editar nota";
  document.getElementById("btn-salvar-nota-fixa").textContent = "Salvar alterações";
  document.getElementById("nf-arquivo-atual").hidden = !n.comprovanteStoragePath;
  document.getElementById("nf-data").value = n.data ?? "";
  preencherCampoMoeda("nf-valor", n.valor);
  document.getElementById("nf-descricao").value = n.descricao ?? "";
  modalNotaFixa.classList.add("show");
}
document.getElementById("btn-cancelar-nota-fixa").addEventListener("click", () => {
  state.editandoNotaId = null;
  state.notaFixaRelatorioAtual = null;
  modalNotaFixa.classList.remove("show");
});
document.getElementById("btn-fechar-nota-fixa").addEventListener("click", () => {
  document.getElementById("btn-cancelar-nota-fixa").click();
});

function arquivoParaBase64(arquivo) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error("Não foi possível ler o arquivo."));
    reader.readAsDataURL(arquivo);
  });
}

document.getElementById("btn-detectar-valor").addEventListener("click", async () => {
  const arquivo = document.getElementById("nf-arquivo").files[0];
  if (!arquivo) { toast("Escolha um arquivo primeiro.", true); return; }
  const btn = document.getElementById("btn-detectar-valor");
  const textoOriginal = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Lendo...";
  try {
    const base64 = await arquivoParaBase64(arquivo);
    const { data } = await extrairValorNota({ base64, mimeType: arquivo.type });
    if (data.valor != null) preencherCampoMoeda("nf-valor", data.valor);
    if (data.data) document.getElementById("nf-data").value = data.data;
    if (!document.getElementById("nf-descricao").value && (data.estabelecimento || data.descricao)) {
      document.getElementById("nf-descricao").value = data.estabelecimento || data.descricao;
    }
    toast(
      data.valor != null
        ? `Valor detectado: R$ ${formatarMoedaExibicao(Number(data.valor))}`
        : "Não consegui identificar o valor nesse arquivo — confira e digite manualmente.",
      data.valor == null
    );
  } catch (err) {
    toast("Erro ao detectar valor: " + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = textoOriginal;
  }
});

document.getElementById("form-nota-fixa").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btnSalvar = document.getElementById("btn-salvar-nota-fixa");
  if (btnSalvar.disabled) return;
  const editandoId = state.editandoNotaId;
  const arquivo = document.getElementById("nf-arquivo").files[0];
  if (!editandoId && !arquivo) {
    toast("Anexe o arquivo da nota, cupom ou comprovante.", true);
    return;
  }
  const textoOriginal = btnSalvar.textContent;
  btnSalvar.disabled = true;
  btnSalvar.textContent = editandoId ? "Salvando..." : "Criando...";
  try {
    const payload = {
      relatorioFixoId: state.notaFixaRelatorioAtual,
      data: document.getElementById("nf-data").value,
      valor: lerCampoMoeda("nf-valor"),
      descricao: document.getElementById("nf-descricao").value || null,
      atualizadoEm: serverTimestamp(),
    };
    let notaId = editandoId;
    if (editandoId) {
      await updateDoc(doc(db, "notasFixas", editandoId), payload);
    } else {
      const docRef = await addDoc(collection(db, "notasFixas"), {
        ...payload, comprovanteStoragePath: null, criadoEm: serverTimestamp(),
      });
      notaId = docRef.id;
    }
    if (arquivo) {
      const path = `notas-fixas/${notaId}/original.${arquivo.name.split(".").pop()}`;
      await uploadBytes(ref(storage, path), arquivo);
      await updateDoc(doc(db, "notasFixas", notaId), { comprovanteStoragePath: path });
    }
    state.editandoNotaId = null;
    state.notaFixaRelatorioAtual = null;
    modalNotaFixa.classList.remove("show");
    toast(editandoId ? "Nota atualizada." : "Nota adicionada.");
  } catch (err) {
    toast("Erro ao salvar nota: " + err.message, true);
  } finally {
    btnSalvar.disabled = false;
    btnSalvar.textContent = textoOriginal;
  }
});

// Fecha ao clicar fora da caixa ou apertando Esc (mesmo padrão dos outros modais)
[modalRelatorioFixo, modalNotaFixa].forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.querySelector(".modal-close").click();
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (modalRelatorioFixo.classList.contains("show")) document.getElementById("btn-fechar-relatorio-fixo").click();
  else if (modalNotaFixa.classList.contains("show")) document.getElementById("btn-fechar-nota-fixa").click();
});

function tabelaNotasPdf(doc, notas, startY) {
  const linhas = notas.map((n) => [
    n.data ?? "—", n.descricao ?? "—", n.valor != null ? `R$ ${formatarMoedaExibicao(n.valor)}` : "—",
  ]);
  const total = notas.reduce((s, n) => s + (n.valor ?? 0), 0);
  doc.autoTable({
    startY: startY ?? 36,
    head: [["Data", "Descrição", "Valor"]],
    body: linhas,
    foot: [["", "Total", `R$ ${formatarMoedaExibicao(total)}`]],
    styles: { fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: [23, 27, 37] },
    footStyles: { fillColor: [23, 27, 37], fontStyle: "bold" },
    columnStyles: { 2: { halign: "right" } },
  });
  return total;
}

function baixarPdfRelatorioFixo(relatorio) {
  const notasDoRelatorio = state.notasFixas.filter((n) => n.relatorioFixoId === relatorio.id);
  const doc = novoPdf(relatorio.nome, `${notasDoRelatorio.length} nota(s)`);
  if (notasDoRelatorio.length === 0) {
    doc.setFontSize(11);
    doc.setTextColor(120);
    doc.text("Nenhuma nota guardada neste relatório ainda.", 14, 40);
  } else {
    tabelaNotasPdf(doc, notasDoRelatorio);
  }
  doc.save(nomeArquivo(relatorio.nome));
}

// ---------- COMPROMISSOS MENSAIS ----------
function somarMeses(mesIso, quantidade) {
  const [ano, mes] = mesIso.split("-").map(Number);
  const data = new Date(ano, mes - 1 + quantidade, 1);
  return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, "0")}`;
}

function numeroDaParcela(c, mesSelecionado) {
  const [anoInicio, mesInicio] = c.mesInicio.split("-").map(Number);
  const [anoSel, mesSel] = mesSelecionado.split("-").map(Number);
  return (anoSel - anoInicio) * 12 + (mesSel - mesInicio) + 1;
}

// Recorrente (parcelas == null) conta em todo mês a partir do mês de início.
// Parcelado conta só enquanto o mês selecionado estiver dentro do número de parcelas.
function compromissoAtivoNoMes(c, mesSelecionado) {
  if (!c.mesInicio || c.mesInicio > mesSelecionado) return false;
  if (c.parcelas == null) return true;
  const mesFim = somarMeses(c.mesInicio, c.parcelas - 1);
  return mesSelecionado <= mesFim;
}

function botoesAcaoCompromisso(c) {
  return `<div class="row-actions">
    <button class="btn btn-sm" data-editar-compromisso="${c.id}">Editar</button>
    <button class="btn btn-sm btn-danger" data-excluir-compromisso="${c.id}">Excluir</button>
  </div>`;
}

function renderCompromissos() {
  const inputMes = document.getElementById("compromissos-mes");
  if (!inputMes.value) inputMes.value = mesAtualISO();
  const mesSelecionado = inputMes.value;

  const ativos = state.compromissos.filter((c) => compromissoAtivoNoMes(c, mesSelecionado));
  const totalCompromissos = ativos.reduce((s, c) => s + (c.valor ?? 0), 0);
  const totalPessoal = state.despesas
    .filter((d) => d.tipoDespesa === "pessoal" && d.data && d.data.startsWith(mesSelecionado))
    .reduce((s, d) => s + (d.valor ?? 0), 0);
  const subtotal = totalCompromissos + totalPessoal;

  document.getElementById("compromissos-metrics").innerHTML = `
    <div class="metric-card"><div class="metric-label">Compromissos no mês</div><div class="metric-value">R$ ${formatarMoedaExibicao(totalCompromissos)}</div></div>
    <div class="metric-card"><div class="metric-label">Despesas pessoais no mês</div><div class="metric-value">R$ ${formatarMoedaExibicao(totalPessoal)}</div></div>
    <div class="metric-card"><div class="metric-label">Subtotal (compromissos + pessoal)</div><div class="metric-value green">R$ ${formatarMoedaExibicao(subtotal)}</div></div>
  `;

  document.getElementById("lista-compromissos").innerHTML = ativos.map((c) => {
    const meta = c.parcelas != null ? `${numeroDaParcela(c, mesSelecionado)} de ${c.parcelas}` : "Recorrente";
    return `
      <div class="despesa-card">
        <div class="despesa-card-header" data-toggle-compromisso="${c.id}">
          <span class="icon-badge">${ICON_SVG.carteira}</span>
          <div class="despesa-card-info">
            <div class="despesa-card-desc">${c.nome}</div>
            <div class="despesa-card-meta">${meta}</div>
          </div>
          <div class="despesa-card-valor">R$ ${formatarMoedaExibicao(c.valor ?? 0)}</div>
        </div>
        <div class="despesa-card-body${state.compromissosExpandido.has(c.id) ? " open" : ""}" id="compromisso-body-${c.id}">
          <div class="row-actions">${botoesAcaoCompromisso(c)}</div>
        </div>
      </div>`;
  }).join("") || `<p class="page-subtitle" style="padding: 18px;">Nenhum compromisso neste mês.</p>`;

  document.querySelectorAll("#lista-compromissos [data-toggle-compromisso]").forEach((header) => {
    header.addEventListener("click", () => {
      const id = header.dataset.toggleCompromisso;
      state.compromissosExpandido.has(id) ? state.compromissosExpandido.delete(id) : state.compromissosExpandido.add(id);
      document.getElementById(`compromisso-body-${id}`).classList.toggle("open");
    });
  });
  document.querySelectorAll("#lista-compromissos [data-editar-compromisso]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const c = state.compromissos.find((x) => x.id === btn.dataset.editarCompromisso);
      if (c) abrirModalCompromissoEdicao(c);
    });
  });
  document.querySelectorAll("#lista-compromissos [data-excluir-compromisso]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Excluir este compromisso mensal? Essa ação não pode ser desfeita.")) return;
      try {
        await deleteDoc(doc(db, "compromissosMensais", btn.dataset.excluirCompromisso));
        toast("Compromisso excluído.");
      } catch (err) {
        toast("Erro ao excluir compromisso: " + err.message, true);
      }
    });
  });
}
document.getElementById("compromissos-mes").addEventListener("change", renderCompromissos);

const modalCompromisso = document.getElementById("modal-compromisso");
function toggleCampoParcelas() {
  document.getElementById("campo-parcelas").hidden = document.getElementById("cm-tipo-parcelas").value !== "parcelado";
}
document.getElementById("cm-tipo-parcelas").addEventListener("change", toggleCampoParcelas);

document.getElementById("btn-novo-compromisso").addEventListener("click", () => {
  state.editandoCompromissoId = null;
  document.getElementById("form-compromisso").reset();
  document.getElementById("modal-compromisso-eyebrow").textContent = "Compromissos Mensais";
  document.getElementById("modal-compromisso-titulo").textContent = "Novo compromisso mensal";
  document.getElementById("btn-salvar-compromisso").textContent = "Criar";
  document.getElementById("cm-mes-inicio").value = document.getElementById("compromissos-mes").value || mesAtualISO();
  document.getElementById("cm-tipo-parcelas").value = "recorrente";
  toggleCampoParcelas();
  modalCompromisso.classList.add("show");
});
function abrirModalCompromissoEdicao(c) {
  state.editandoCompromissoId = c.id;
  document.getElementById("form-compromisso").reset();
  document.getElementById("modal-compromisso-eyebrow").textContent = "Editar";
  document.getElementById("modal-compromisso-titulo").textContent = "Editar compromisso mensal";
  document.getElementById("btn-salvar-compromisso").textContent = "Salvar alterações";
  document.getElementById("cm-nome").value = c.nome ?? "";
  preencherCampoMoeda("cm-valor", c.valor);
  document.getElementById("cm-mes-inicio").value = c.mesInicio ?? mesAtualISO();
  document.getElementById("cm-tipo-parcelas").value = c.parcelas != null ? "parcelado" : "recorrente";
  document.getElementById("cm-parcelas").value = c.parcelas ?? "";
  toggleCampoParcelas();
  modalCompromisso.classList.add("show");
}
document.getElementById("btn-cancelar-compromisso").addEventListener("click", () => {
  state.editandoCompromissoId = null;
  modalCompromisso.classList.remove("show");
});
document.getElementById("btn-fechar-compromisso").addEventListener("click", () => {
  document.getElementById("btn-cancelar-compromisso").click();
});
document.getElementById("form-compromisso").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btnSalvar = document.getElementById("btn-salvar-compromisso");
  if (btnSalvar.disabled) return;
  const editandoId = state.editandoCompromissoId;
  const textoOriginal = btnSalvar.textContent;
  btnSalvar.disabled = true;
  btnSalvar.textContent = editandoId ? "Salvando..." : "Criando...";
  try {
    const tipoParcelas = document.getElementById("cm-tipo-parcelas").value;
    const payload = {
      nome: document.getElementById("cm-nome").value,
      valor: lerCampoMoeda("cm-valor"),
      mesInicio: document.getElementById("cm-mes-inicio").value,
      parcelas: tipoParcelas === "parcelado" ? Number(document.getElementById("cm-parcelas").value) : null,
    };
    if (editandoId) {
      await updateDoc(doc(db, "compromissosMensais", editandoId), payload);
    } else {
      await addDoc(collection(db, "compromissosMensais"), { ...payload, criadoEm: serverTimestamp() });
    }
    state.editandoCompromissoId = null;
    modalCompromisso.classList.remove("show");
    toast(editandoId ? "Compromisso atualizado." : "Compromisso mensal criado.");
  } catch (err) {
    toast("Erro ao salvar compromisso: " + err.message, true);
  } finally {
    btnSalvar.disabled = false;
    btnSalvar.textContent = textoOriginal;
  }
});

[modalCompromisso].forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.querySelector(".modal-close").click();
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (modalCompromisso.classList.contains("show")) document.getElementById("btn-fechar-compromisso").click();
});

// ---------- SUBVENÇÕES ----------
function botoesAcaoSubvencao(s) {
  const proximoStatus = s.status === "pendente" ? "recebida" : "pendente";
  const textoToggle = s.status === "pendente" ? "Marcar como recebida" : "Marcar como pendente";
  return `<div class="row-actions">
    <button class="btn btn-sm" data-toggle-status-subvencao="${s.id}" data-proximo-status="${proximoStatus}">${textoToggle}</button>
    <button class="btn btn-sm" data-editar-subvencao="${s.id}">Editar</button>
    <button class="btn btn-sm btn-danger" data-excluir-subvencao="${s.id}">Excluir</button>
  </div>`;
}

function renderSubvencoes() {
  const status = document.getElementById("filtro-status-subvencao").value;
  const filtradas = state.subvencoes.filter((s) => !status || s.status === status);

  const totalPendente = state.subvencoes.filter((s) => s.status === "pendente").reduce((sum, s) => sum + (s.valor ?? 0), 0);
  const totalRecebido = state.subvencoes.filter((s) => s.status === "recebida").reduce((sum, s) => sum + (s.valor ?? 0), 0);

  document.getElementById("subvencoes-metrics").innerHTML = `
    <div class="metric-card"><div class="metric-label">A receber (pendente)</div><div class="metric-value amber">R$ ${formatarMoedaExibicao(totalPendente)}</div></div>
    <div class="metric-card"><div class="metric-label">Recebido</div><div class="metric-value green">R$ ${formatarMoedaExibicao(totalRecebido)}</div></div>
    <div class="metric-card"><div class="metric-label">Total geral</div><div class="metric-value">R$ ${formatarMoedaExibicao((totalPendente + totalRecebido))}</div></div>
  `;

  document.querySelector("#tabela-subvencoes tbody").innerHTML = filtradas.map((s) => `
    <tr>
      <td data-label="Origem">
        <span class="row-origem"><span class="icon-badge icon-${s.origem}">${ICON_SVG.cifrao}</span>${ORIGEM_SUBVENCAO_LABEL[s.origem] ?? s.origem}</span>
      </td>
      <td data-label="Observação">${s.observacao ?? ""}</td>
      <td data-label="Valor" class="td-mono ${s.status === "recebida" ? "valor-recebido" : "valor-pendente"}">R$ ${formatarMoedaExibicao((s.valor ?? 0))}</td>
      <td data-label="Status"><span class="badge ${STATUS_SUBVENCAO_BADGE[s.status]}">${STATUS_SUBVENCAO_LABEL[s.status] ?? s.status}</span></td>
      <td data-label="Ações">${botoesAcaoSubvencao(s)}</td>
    </tr>
  `).join("") || `<tr><td colspan="5">Nenhuma subvenção lançada ainda.</td></tr>`;

  document.querySelectorAll("#tabela-subvencoes [data-toggle-status-subvencao]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await updateDoc(doc(db, "subvencoes", btn.dataset.toggleStatusSubvencao), { status: btn.dataset.proximoStatus });
        toast(`Subvenção marcada como "${STATUS_SUBVENCAO_LABEL[btn.dataset.proximoStatus]}".`);
      } catch (err) {
        toast("Erro ao atualizar subvenção: " + err.message, true);
      }
    });
  });
  document.querySelectorAll("#tabela-subvencoes [data-editar-subvencao]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const s = state.subvencoes.find((x) => x.id === btn.dataset.editarSubvencao);
      if (s) abrirModalSubvencaoEdicao(s);
    });
  });
  document.querySelectorAll("#tabela-subvencoes [data-excluir-subvencao]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Excluir esta subvenção? Essa ação não pode ser desfeita.")) return;
      try {
        await deleteDoc(doc(db, "subvencoes", btn.dataset.excluirSubvencao));
        toast("Subvenção excluída.");
      } catch (err) {
        toast("Erro ao excluir subvenção: " + err.message, true);
      }
    });
  });
}
document.getElementById("filtro-status-subvencao").addEventListener("change", renderSubvencoes);

const modalSubvencao = document.getElementById("modal-subvencao");
document.getElementById("btn-nova-subvencao").addEventListener("click", () => {
  state.editandoSubvencaoId = null;
  document.getElementById("form-subvencao").reset();
  document.getElementById("modal-subvencao-eyebrow").textContent = "Subvenções";
  document.getElementById("modal-subvencao-titulo").textContent = "Nova subvenção";
  document.getElementById("btn-salvar-subvencao").textContent = "Criar";
  modalSubvencao.classList.add("show");
});
function abrirModalSubvencaoEdicao(s) {
  state.editandoSubvencaoId = s.id;
  document.getElementById("form-subvencao").reset();
  document.getElementById("modal-subvencao-eyebrow").textContent = "Editar";
  document.getElementById("modal-subvencao-titulo").textContent = "Editar subvenção";
  document.getElementById("btn-salvar-subvencao").textContent = "Salvar alterações";
  document.getElementById("sv-origem").value = s.origem ?? "uniao";
  preencherCampoMoeda("sv-valor", s.valor);
  document.getElementById("sv-status").value = s.status ?? "pendente";
  document.getElementById("sv-observacao").value = s.observacao ?? "";
  modalSubvencao.classList.add("show");
}
document.getElementById("btn-cancelar-subvencao").addEventListener("click", () => {
  state.editandoSubvencaoId = null;
  modalSubvencao.classList.remove("show");
});
document.getElementById("btn-fechar-subvencao").addEventListener("click", () => {
  document.getElementById("btn-cancelar-subvencao").click();
});
document.getElementById("form-subvencao").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btnSalvar = document.getElementById("btn-salvar-subvencao");
  if (btnSalvar.disabled) return;
  const editandoId = state.editandoSubvencaoId;
  const textoOriginal = btnSalvar.textContent;
  btnSalvar.disabled = true;
  btnSalvar.textContent = editandoId ? "Salvando..." : "Criando...";
  try {
    const payload = {
      origem: document.getElementById("sv-origem").value,
      valor: lerCampoMoeda("sv-valor"),
      status: document.getElementById("sv-status").value,
      observacao: document.getElementById("sv-observacao").value,
    };
    if (editandoId) {
      await updateDoc(doc(db, "subvencoes", editandoId), payload);
    } else {
      await addDoc(collection(db, "subvencoes"), { ...payload, criadoEm: serverTimestamp() });
    }
    state.editandoSubvencaoId = null;
    modalSubvencao.classList.remove("show");
    toast(editandoId ? "Subvenção atualizada." : "Subvenção lançada.");
  } catch (err) {
    toast("Erro ao salvar subvenção: " + err.message, true);
  } finally {
    btnSalvar.disabled = false;
    btnSalvar.textContent = textoOriginal;
  }
});

[modalSubvencao].forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.querySelector(".modal-close").click();
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (modalSubvencao.classList.contains("show")) document.getElementById("btn-fechar-subvencao").click();
});

// ---------- REEMBOLSO ----------
const enviarParaReembolso = httpsCallable(functions, "enviarParaReembolso");
const baixarComprovantesZipCallable = httpsCallable(functions, "baixarComprovantesZip");

async function baixarComprovantesZip(despesas, nomeBase) {
  const todosCaminhos = despesas.flatMap(recibosDe);
  if (todosCaminhos.length === 0) {
    toast("Nenhum comprovante anexado nessas despesas.", true);
    return;
  }
  toast(`Preparando ${todosCaminhos.length} comprovante(s)...`);
  try {
    const { data } = await baixarComprovantesZipCallable({
      storagePaths: todosCaminhos,
    });
    const binario = atob(data.base64);
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
    const blob = new Blob([bytes], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nomeArquivo(nomeBase, "zip");
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`${data.total} comprovante(s) baixado(s).`);
  } catch (err) {
    toast("Erro ao baixar comprovantes: " + err.message, true);
  }
}

document.querySelectorAll("#section-reembolso [data-canal]").forEach((btn) => {
  btn.addEventListener("click", () => abrirModalReembolso({ tipoDespesa: "departamento" }));
});

document.getElementById("btn-enviar-reembolso-departamento").addEventListener("click", () => {
  if (state.selecionadas.size === 0) { toast("Selecione ao menos uma despesa pendente.", true); return; }
  abrirModalReembolso({ despesaIds: Array.from(state.selecionadas) });
});

document.getElementById("btn-enviar-tudo-departamento").addEventListener("click", () => {
  const pendentes = state.despesas.filter((d) => d.tipoDespesa === "departamento" && d.statusReembolso === "pendente");
  if (pendentes.length === 0) { toast("Nenhuma despesa de departamento pendente de reembolso.", true); return; }
  abrirModalReembolso({ tipoDespesa: "departamento" });
});

async function acionarReembolso(filtro = {}) {
  try {
    const { data } = await enviarParaReembolso(filtro);
    toast(`${data.enviado} despesa(s) enviada(s) para reembolso por e-mail.`);
    state.selecionadas.clear();
  } catch (err) {
    toast("Erro ao enviar para reembolso: " + err.message, true);
  }
}

// ---------- MODAL ESCOLHA DO FUNDO (antes de enviar reembolso) ----------
const modalReembolso = document.getElementById("modal-reembolso");
let filtroReembolsoPendente = null;

function abrirModalReembolso(filtro) {
  filtroReembolsoPendente = filtro;
  modalReembolso.classList.add("show");
}
document.getElementById("btn-fechar-reembolso-modal").addEventListener("click", () => {
  filtroReembolsoPendente = null;
  modalReembolso.classList.remove("show");
});
document.querySelectorAll("#modal-reembolso [data-fundo]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const fundo = btn.dataset.fundo;
    modalReembolso.classList.remove("show");
    if (filtroReembolsoPendente) acionarReembolso({ ...filtroReembolsoPendente, fundo });
    filtroReembolsoPendente = null;
  });
});
[modalReembolso].forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.querySelector(".modal-close").click();
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (modalReembolso.classList.contains("show")) document.getElementById("btn-fechar-reembolso-modal").click();
});

// ---------- CONFIGURAÇÕES DE REEMBOLSO (conta / centro de custo) ----------
document.getElementById("form-config-reembolso").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await setDoc(
      doc(db, "configuracoes", "reembolso"),
      {
        banco: document.getElementById("cfg-banco").value.trim(),
        contaReembolso: document.getElementById("cfg-conta").value.trim(),
        chavePix: document.getElementById("cfg-chave-pix").value.trim(),
        centroCusto: document.getElementById("cfg-centro-custo").value.trim(),
      },
      { merge: true }
    );
    toast("Dados de reembolso salvos.");
  } catch (err) {
    toast("Erro ao salvar dados de reembolso: " + err.message, true);
  }
});

// ---------- PDF ----------
function novoPdf(titulo, subtitulo) {
  if (!window.jspdf) {
    throw new Error("Biblioteca de PDF não carregou. Verifique sua conexão e recarregue a página.");
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(`Eleve — ${titulo}`, 14, 18);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(130);
  doc.text(`Gerado em ${new Date().toLocaleString("pt-BR")}`, 14, 24);
  if (subtitulo) {
    doc.setFontSize(10.5);
    doc.setTextColor(60);
    doc.text(subtitulo, 14, 31);
  }
  return doc;
}

function tabelaDespesasPdf(doc, despesas, startY, omitirTipo) {
  const colunas = omitirTipo
    ? ["Data", "Descrição", "Categoria", "Status", "Valor"]
    : ["Data", "Descrição", "Categoria", "Tipo", "Status", "Valor"];
  const linhas = despesas.map((d) => {
    const linha = [
      d.data ?? "—",
      d.descricao ?? "",
      CATEGORIA_LABEL[d.categoria] ?? d.categoria,
    ];
    if (!omitirTipo) linha.push(d.tipoDespesa ?? "—");
    linha.push(STATUS_LABEL[d.statusReembolso] ?? d.statusReembolso, `R$ ${formatarMoedaExibicao((d.valor ?? 0))}`);
    return linha;
  });
  const total = despesas.reduce((s, d) => s + (d.valor ?? 0), 0);
  const ultimaColuna = colunas.length - 1;
  const linhaTotal = colunas.map(() => "");
  linhaTotal[ultimaColuna - 1] = "Total";
  linhaTotal[ultimaColuna] = `R$ ${formatarMoedaExibicao(total)}`;
  doc.autoTable({
    startY: startY ?? 36,
    head: [colunas],
    body: linhas,
    foot: [linhaTotal],
    styles: { fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: [23, 27, 37] },
    footStyles: { fillColor: [23, 27, 37], fontStyle: "bold" },
    columnStyles: { [ultimaColuna]: { halign: "right" } },
  });
  return total;
}

function nomeArquivo(base, extensao = "pdf") {
  return base.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w-]+/g, "_") + "." + extensao;
}

function baixarPdfRelatorio(relatorio) {
  const despesasDoRelatorio = state.despesas.filter((d) => d.relatorioViagemId === relatorio.id);
  const subtitulo = [relatorio.destino, formatarPeriodo(relatorio)].filter(Boolean).join(" · ") || undefined;
  const doc = novoPdf(relatorio.nome, subtitulo);
  if (despesasDoRelatorio.length === 0) {
    doc.setFontSize(11);
    doc.setTextColor(120);
    doc.text("Nenhuma despesa lançada neste relatório ainda.", 14, 40);
  } else {
    tabelaDespesasPdf(doc, despesasDoRelatorio);
  }
  doc.save(nomeArquivo(relatorio.nome));
}

document.getElementById("btn-pdf-departamento").addEventListener("click", () => {
  const status = document.getElementById("filtro-status-departamento").value;
  const filtradas = state.despesas.filter((d) => d.tipoDespesa === "departamento" && (!status || d.statusReembolso === status));
  if (filtradas.length === 0) { toast("Nenhuma despesa de departamento para exportar.", true); return; }
  const doc = novoPdf("Despesas de Departamento", status ? STATUS_LABEL[status] : "Todos os status");
  tabelaDespesasPdf(doc, filtradas);
  doc.save(nomeArquivo("eleve-despesas-departamento"));
});

document.getElementById("btn-comprovantes-departamento").addEventListener("click", () => {
  const status = document.getElementById("filtro-status-departamento").value;
  const filtradas = state.despesas.filter((d) => d.tipoDespesa === "departamento" && (!status || d.statusReembolso === status));
  baixarComprovantesZip(filtradas, "eleve-comprovantes-departamento");
});

document.getElementById("btn-pdf-pessoal").addEventListener("click", () => {
  const filtradas = state.despesas.filter((d) => d.tipoDespesa === "pessoal");
  if (filtradas.length === 0) { toast("Nenhuma despesa pessoal para exportar.", true); return; }
  const doc = novoPdf("Despesas Pessoais", `${filtradas.length} lançamento(s)`);
  tabelaDespesasPdf(doc, filtradas);
  doc.save(nomeArquivo("eleve-despesas-pessoais"));
});

document.getElementById("btn-comprovantes-pessoal").addEventListener("click", () => {
  const filtradas = state.despesas.filter((d) => d.tipoDespesa === "pessoal");
  baixarComprovantesZip(filtradas, "eleve-comprovantes-pessoais");
});

document.getElementById("btn-pdf-extrato").addEventListener("click", () => {
  if (state.despesas.length === 0) { toast("Nenhuma despesa lançada ainda.", true); return; }
  const doc = novoPdf("Extrato completo", `${state.despesas.length} lançamento(s)`);

  const grupos = GRUPOS_TIPO_DESPESA;

  let y = 36;
  let totalGeral = 0;
  const pageHeight = doc.internal.pageSize.getHeight();

  for (const grupo of grupos) {
    const despesasGrupo = state.despesas.filter((d) => d.tipoDespesa === grupo.tipo);
    if (despesasGrupo.length === 0) continue;

    if (y > pageHeight - 40) {
      doc.addPage();
      y = 20;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(12.5);
    doc.setTextColor(20);
    doc.text(grupo.titulo, 14, y);
    y += 6;

    totalGeral += tabelaDespesasPdf(doc, despesasGrupo, y, true);
    y = doc.lastAutoTable.finalY + 16;
  }

  if (y > pageHeight - 20) {
    doc.addPage();
    y = 20;
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(20);
  doc.text(`Total geral: R$ ${formatarMoedaExibicao(totalGeral)}`, 14, y);

  doc.save(nomeArquivo("eleve-extrato"));
});

document.getElementById("btn-pdf-reembolso").addEventListener("click", () => {
  const pendentes = state.despesas.filter((d) => d.tipoDespesa === "departamento" && d.statusReembolso === "pendente");
  if (pendentes.length === 0) { toast("Nenhuma despesa de departamento pendente de reembolso.", true); return; }
  const doc = novoPdf("Pacote de reembolso — Departamento", `${pendentes.length} despesa(s) pendente(s)`);
  tabelaDespesasPdf(doc, pendentes, undefined, true);
  doc.save(nomeArquivo("eleve-reembolso-departamento"));
});

document.getElementById("btn-comprovantes-reembolso").addEventListener("click", () => {
  const pendentes = state.despesas.filter((d) => d.tipoDespesa === "departamento" && d.statusReembolso === "pendente");
  baixarComprovantesZip(pendentes, "eleve-comprovantes-reembolso-departamento");
});
