import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, query, orderBy, serverTimestamp,
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
};

const CATEGORIA_LABEL = {
  combustivel: "Combustível", hospedagem: "Hospedagem", alimentacao: "Alimentação",
  transporte: "Transporte", carro_alugado: "Carro alugado", material: "Material",
  servicos: "Serviços", outros: "Outros",
};
const STATUS_LABEL = {
  pendente: "Pendente", enviado: "Enviado", reembolsado: "Reembolsado", nao_reembolsavel: "—",
};
const STATUS_RELATORIO_LABEL = { aberto: "Aberto", enviado: "Enviado", pago: "Pago" };
const STATUS_RELATORIO_BADGE = { aberto: "badge-pendente", enviado: "badge-enviado", pago: "badge-reembolsado" };
const GRUPOS_TIPO_DESPESA = [
  { titulo: "Viagem", tipo: "viagem" },
  { titulo: "Departamento", tipo: "departamento" },
  { titulo: "Pessoal", tipo: "pessoal" },
];

function calcularReembolsavel(tipo) { return tipo === "viagem" || tipo === "departamento"; }

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
  });
  onSnapshot(collection(db, "relatoriosViagem"), (snap) => {
    state.relatorios = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    popularSelectRelatorios();
    renderRelatorios();
  });
}

// ---------- DASHBOARD ----------
function renderDashboard() {
  const hoje = new Date();
  const mesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
  const totalMes = state.despesas
    .filter((d) => d.data && d.data.startsWith(mesAtual))
    .reduce((s, d) => s + (d.valor ?? 0), 0);
  const totalPendente = state.despesas
    .filter((d) => d.statusReembolso === "pendente")
    .reduce((s, d) => s + (d.valor ?? 0), 0);
  const porTipo = { viagem: 0, departamento: 0, pessoal: 0 };
  state.despesas.forEach((d) => { if (d.tipoDespesa) porTipo[d.tipoDespesa] += d.valor ?? 0; });

  document.getElementById("dashboard-metrics").innerHTML = `
    <div class="metric-card"><div class="metric-label">Gasto no mês</div><div class="metric-value">R$ ${totalMes.toFixed(2)}</div></div>
    <button type="button" class="metric-card clickable" id="metric-pendente-reembolso">
      <div class="metric-label">Pendente de reembolso</div>
      <div class="metric-value amber">R$ ${totalPendente.toFixed(2)}</div>
      <div class="metric-hint">Ver por área →</div>
    </button>
    <div class="metric-card"><div class="metric-label">Viagem</div><div class="metric-value">R$ ${porTipo.viagem.toFixed(2)}</div></div>
    <div class="metric-card"><div class="metric-label">Departamento</div><div class="metric-value">R$ ${porTipo.departamento.toFixed(2)}</div></div>
    <div class="metric-card"><div class="metric-label">Pessoal</div><div class="metric-value">R$ ${porTipo.pessoal.toFixed(2)}</div></div>
  `;
  document.getElementById("metric-pendente-reembolso").addEventListener("click", abrirModalPendentes);

  const recentes = state.despesas.slice(0, 8);
  document.querySelector("#dashboard-recent tbody").innerHTML = recentes.map(linhaDespesaSimples).join("") ||
    `<tr><td colspan="6">Nenhum lançamento ainda.</td></tr>`;

  if (modalPendentes.classList.contains("show")) renderPendentesModal();
}

// ---------- MODAL PENDENTE DE REEMBOLSO POR ÁREA ----------
const modalPendentes = document.getElementById("modal-pendentes");
function renderPendentesModal() {
  const pendentes = state.despesas.filter((d) => d.statusReembolso === "pendente");
  document.getElementById("pendentes-conteudo").innerHTML = GRUPOS_TIPO_DESPESA.map((grupo) => {
    const despesasGrupo = pendentes.filter((d) => d.tipoDespesa === grupo.tipo);
    if (despesasGrupo.length === 0) return "";
    const total = despesasGrupo.reduce((s, d) => s + (d.valor ?? 0), 0);
    return `
      <div class="pendentes-grupo">
        <div class="pendentes-grupo-header">
          <span class="pendentes-grupo-titulo">${grupo.titulo} · ${despesasGrupo.length} despesa(s)</span>
          <span class="pendentes-grupo-total">R$ ${total.toFixed(2)}</span>
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
    <td data-label="Valor" class="td-mono">R$ ${(d.valor ?? 0).toFixed(2)}</td>
    <td data-label="Ações">${botoesAcaoDespesa(d)}</td>
  </tr>`;
}

// ---------- AÇÕES COMPARTILHADAS (ver recibo / editar / excluir) ----------
function botoesAcaoDespesa(d) {
  return `<div class="row-actions">
    ${d.comprovanteStoragePath ? `<button class="btn btn-sm" data-ver-comprovante="${d.id}">Ver recibo</button>` : ""}
    <button class="btn btn-sm" data-editar-despesa="${d.id}">Editar</button>
    <button class="btn btn-sm btn-danger" data-excluir-despesa="${d.id}">Excluir</button>
  </div>`;
}

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
    const url = await getDownloadURL(ref(storage, d.comprovanteStoragePath));
    window.open(url, "_blank");
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
  }
});

function renderDepartamento() {
  const status = document.getElementById("filtro-status-departamento").value;
  const filtradas = state.despesas.filter((d) =>
    d.tipoDespesa === "departamento" && (!status || d.statusReembolso === status)
  );

  document.querySelector("#tabela-departamento tbody").innerHTML = filtradas.map((d) => `
    <tr>
      <td data-label="Selecionar"><input type="checkbox" class="chk-despesa" data-id="${d.id}" ${d.statusReembolso === "pendente" ? "" : "disabled"} /></td>
      <td data-label="Data">${d.data ?? "—"}</td>
      <td data-label="Descrição">${d.descricao ?? ""}</td>
      <td data-label="Categoria">${CATEGORIA_LABEL[d.categoria] ?? d.categoria}</td>
      <td data-label="Origem">${d.origem ?? ""}</td>
      <td data-label="Status"><span class="badge badge-${d.statusReembolso}">${STATUS_LABEL[d.statusReembolso] ?? d.statusReembolso}</span></td>
      <td data-label="Valor" class="td-mono">R$ ${(d.valor ?? 0).toFixed(2)}</td>
      <td data-label="Ações">${botoesAcaoDespesa(d)}</td>
    </tr>
  `).join("") || `<tr><td colspan="8">Nenhuma despesa de departamento lançada ainda.</td></tr>`;

  document.querySelectorAll("#tabela-departamento .chk-despesa").forEach((chk) => {
    chk.addEventListener("change", () => {
      chk.checked ? state.selecionadas.add(chk.dataset.id) : state.selecionadas.delete(chk.dataset.id);
    });
  });
}
document.getElementById("filtro-status-departamento").addEventListener("change", renderDepartamento);

// ---------- DESPESAS PESSOAIS ----------
function renderPessoal() {
  const filtradas = state.despesas.filter((d) => d.tipoDespesa === "pessoal");

  document.querySelector("#tabela-pessoal tbody").innerHTML = filtradas.map((d) => `
    <tr>
      <td data-label="Data">${d.data ?? "—"}</td>
      <td data-label="Descrição">${d.descricao ?? ""}</td>
      <td data-label="Categoria">${CATEGORIA_LABEL[d.categoria] ?? d.categoria}</td>
      <td data-label="Origem">${d.origem ?? ""}</td>
      <td data-label="Valor" class="td-mono">R$ ${(d.valor ?? 0).toFixed(2)}</td>
      <td data-label="Ações">${botoesAcaoDespesa(d)}</td>
    </tr>
  `).join("") || `<tr><td colspan="6">Nenhuma despesa pessoal lançada ainda.</td></tr>`;

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
  document.getElementById("d-valor").value = d.valor ?? "";
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
    valor: Number(document.getElementById("d-valor").value),
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
          <div class="relatorio-total">R$ ${total.toFixed(2)}</div>
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
          <table><tbody>${despesasDoRelatorio.map(linhaDespesaSimples).join("") || "<tr><td>Nenhuma despesa ainda.</td></tr>"}</tbody></table>
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

// ---------- REEMBOLSO ----------
const enviarParaReembolso = httpsCallable(functions, "enviarParaReembolso");
const baixarComprovantesZipCallable = httpsCallable(functions, "baixarComprovantesZip");

async function baixarComprovantesZip(despesas, nomeBase) {
  const comComprovante = despesas.filter((d) => d.comprovanteStoragePath);
  if (comComprovante.length === 0) {
    toast("Nenhum comprovante anexado nessas despesas.", true);
    return;
  }
  toast(`Preparando ${comComprovante.length} comprovante(s)...`);
  try {
    const { data } = await baixarComprovantesZipCallable({
      storagePaths: comComprovante.map((d) => d.comprovanteStoragePath),
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
  btn.addEventListener("click", () => acionarReembolso(btn.dataset.canal, { tipoDespesa: "departamento" }));
});

document.getElementById("btn-enviar-reembolso-departamento").addEventListener("click", () => {
  if (state.selecionadas.size === 0) { toast("Selecione ao menos uma despesa pendente.", true); return; }
  const canal = escolherCanal();
  acionarReembolso(canal, { despesaIds: Array.from(state.selecionadas) });
});

document.getElementById("btn-enviar-tudo-departamento").addEventListener("click", () => {
  const pendentes = state.despesas.filter((d) => d.tipoDespesa === "departamento" && d.statusReembolso === "pendente");
  if (pendentes.length === 0) { toast("Nenhuma despesa de departamento pendente de reembolso.", true); return; }
  const canal = escolherCanal();
  acionarReembolso(canal, { tipoDespesa: "departamento" });
});

function escolherCanal() {
  return confirm("OK = enviar por e-mail. Cancelar = enviar por WhatsApp.") ? "email" : "whatsapp";
}

async function acionarReembolso(canal, filtro = {}) {
  try {
    const { data } = await enviarParaReembolso({ canal, ...filtro });
    toast(`${data.enviado} despesa(s) enviada(s) para reembolso por ${canal}.`);
    state.selecionadas.clear();
  } catch (err) {
    toast("Erro ao enviar para reembolso: " + err.message, true);
  }
}

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
    linha.push(STATUS_LABEL[d.statusReembolso] ?? d.statusReembolso, `R$ ${(d.valor ?? 0).toFixed(2)}`);
    return linha;
  });
  const total = despesas.reduce((s, d) => s + (d.valor ?? 0), 0);
  const ultimaColuna = colunas.length - 1;
  const linhaTotal = colunas.map(() => "");
  linhaTotal[ultimaColuna - 1] = "Total";
  linhaTotal[ultimaColuna] = `R$ ${total.toFixed(2)}`;
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
  doc.text(`Total geral: R$ ${totalGeral.toFixed(2)}`, 14, y);

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
