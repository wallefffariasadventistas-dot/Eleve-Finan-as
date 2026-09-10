import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, collection, onSnapshot, addDoc, updateDoc, doc, query, orderBy, serverTimestamp,
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

const state = { despesas: [], relatorios: [], selecionadas: new Set() };

const CATEGORIA_LABEL = {
  combustivel: "Combustível", hospedagem: "Hospedagem", alimentacao: "Alimentação",
  transporte: "Transporte", carro_alugado: "Carro alugado", material: "Material",
  servicos: "Serviços", outros: "Outros",
};
const STATUS_LABEL = {
  pendente: "Pendente", enviado: "Enviado", reembolsado: "Reembolsado", nao_reembolsavel: "—",
};

function calcularReembolsavel(tipo) { return tipo === "viagem" || tipo === "departamento"; }

function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast show" + (isError ? " error" : "");
  setTimeout(() => (el.className = "toast"), 3200);
}

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
    renderDespesas();
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
    <div class="metric-card"><div class="metric-label">Pendente de reembolso</div><div class="metric-value amber">R$ ${totalPendente.toFixed(2)}</div></div>
    <div class="metric-card"><div class="metric-label">Viagem</div><div class="metric-value">R$ ${porTipo.viagem.toFixed(2)}</div></div>
    <div class="metric-card"><div class="metric-label">Departamento</div><div class="metric-value">R$ ${porTipo.departamento.toFixed(2)}</div></div>
    <div class="metric-card"><div class="metric-label">Pessoal</div><div class="metric-value">R$ ${porTipo.pessoal.toFixed(2)}</div></div>
  `;

  const recentes = state.despesas.slice(0, 8);
  document.querySelector("#dashboard-recent tbody").innerHTML = recentes.map(linhaDespesaSimples).join("") ||
    `<tr><td colspan="5">Nenhum lançamento ainda.</td></tr>`;
}

function linhaDespesaSimples(d) {
  return `<tr>
    <td>${d.data ?? "—"}</td>
    <td>${d.descricao ?? ""}</td>
    <td>${CATEGORIA_LABEL[d.categoria] ?? d.categoria}</td>
    <td>${d.tipoDespesa ?? "—"}</td>
    <td class="td-mono">R$ ${(d.valor ?? 0).toFixed(2)}</td>
  </tr>`;
}

// ---------- DESPESAS ----------
function renderDespesas() {
  const tipo = document.getElementById("filtro-tipo").value;
  const status = document.getElementById("filtro-status").value;
  const filtradas = state.despesas.filter((d) =>
    (!tipo || d.tipoDespesa === tipo) && (!status || d.statusReembolso === status)
  );

  document.querySelector("#tabela-despesas tbody").innerHTML = filtradas.map((d) => `
    <tr>
      <td><input type="checkbox" class="chk-despesa" data-id="${d.id}" ${d.statusReembolso === "pendente" ? "" : "disabled"} /></td>
      <td>${d.data ?? "—"}</td>
      <td>${d.descricao ?? ""}</td>
      <td>${CATEGORIA_LABEL[d.categoria] ?? d.categoria}</td>
      <td>${d.tipoDespesa ?? "—"}</td>
      <td>${d.origem ?? ""}</td>
      <td><span class="badge badge-${d.statusReembolso}">${STATUS_LABEL[d.statusReembolso] ?? d.statusReembolso}</span></td>
      <td class="td-mono">R$ ${(d.valor ?? 0).toFixed(2)}</td>
      <td>${d.comprovanteStoragePath ? `<button class="btn btn-sm" data-ver-comprovante="${d.id}">Ver recibo</button>` : ""}</td>
    </tr>
  `).join("") || `<tr><td colspan="9">Nenhuma despesa encontrada.</td></tr>`;

  document.querySelectorAll(".chk-despesa").forEach((chk) => {
    chk.addEventListener("change", () => {
      chk.checked ? state.selecionadas.add(chk.dataset.id) : state.selecionadas.delete(chk.dataset.id);
    });
  });
  document.querySelectorAll("[data-ver-comprovante]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const d = state.despesas.find((x) => x.id === btn.dataset.verComprovante);
      const url = await getDownloadURL(ref(storage, d.comprovanteStoragePath));
      window.open(url, "_blank");
    });
  });
}

document.getElementById("filtro-tipo").addEventListener("change", renderDespesas);
document.getElementById("filtro-status").addEventListener("change", renderDespesas);

// ---------- MODAL DESPESA (lançamento manual) ----------
const modalDespesa = document.getElementById("modal-despesa");
document.getElementById("btn-nova-despesa").addEventListener("click", () => {
  document.getElementById("form-despesa").reset();
  document.getElementById("d-data").value = new Date().toISOString().slice(0, 10);
  toggleCampoRelatorio();
  modalDespesa.classList.add("show");
});
document.getElementById("btn-cancelar-despesa").addEventListener("click", () => modalDespesa.classList.remove("show"));
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
  const tipoDespesa = document.getElementById("d-tipo").value;
  const reembolsavel = calcularReembolsavel(tipoDespesa);
  const payload = {
    data: document.getElementById("d-data").value,
    valor: Number(document.getElementById("d-valor").value),
    categoria: document.getElementById("d-categoria").value,
    tipoDespesa,
    descricao: document.getElementById("d-descricao").value,
    estabelecimento: null,
    finalizado: true,
    reembolsavel,
    statusReembolso: reembolsavel ? "pendente" : "nao_reembolsavel",
    relatorioViagemId: tipoDespesa === "viagem" ? (document.getElementById("d-relatorio").value || null) : null,
    origem: "manual",
    comprovanteStoragePath: null,
    criadoEm: serverTimestamp(),
    atualizadoEm: serverTimestamp(),
  };
  try {
    const docRef = await addDoc(collection(db, "despesas"), payload);
    const arquivo = document.getElementById("d-comprovante").files[0];
    if (arquivo) {
      const path = `recibos/${docRef.id}/original.${arquivo.name.split(".").pop()}`;
      await uploadBytes(ref(storage, path), arquivo);
      await updateDoc(doc(db, "despesas", docRef.id), { comprovanteStoragePath: path });
    }
    modalDespesa.classList.remove("show");
    toast("Despesa lançada com sucesso.");
  } catch (err) {
    toast("Erro ao salvar despesa: " + err.message, true);
  }
});

// ---------- MODAL RELATÓRIO ----------
const modalRelatorio = document.getElementById("modal-relatorio");
document.getElementById("btn-novo-relatorio").addEventListener("click", () => {
  document.getElementById("form-relatorio").reset();
  modalRelatorio.classList.add("show");
});
document.getElementById("btn-cancelar-relatorio").addEventListener("click", () => modalRelatorio.classList.remove("show"));
document.getElementById("form-relatorio").addEventListener("submit", async (e) => {
  e.preventDefault();
  await addDoc(collection(db, "relatoriosViagem"), {
    nome: document.getElementById("r-nome").value,
    destino: document.getElementById("r-destino").value || null,
    dataInicio: null, dataFim: null, status: "aberto", criadoEm: serverTimestamp(),
  });
  modalRelatorio.classList.remove("show");
  toast("Relatório de viagem criado.");
});

// ---------- RELATÓRIOS DE VIAGEM ----------
function renderRelatorios() {
  document.getElementById("lista-relatorios").innerHTML = state.relatorios.map((r) => {
    const despesasDoRelatorio = state.despesas.filter((d) => d.relatorioViagemId === r.id);
    const total = despesasDoRelatorio.reduce((s, d) => s + (d.valor ?? 0), 0);
    return `
      <div class="relatorio-card">
        <div class="relatorio-header" data-toggle="${r.id}">
          <div>
            <div class="relatorio-nome">${r.nome} ${r.status === "encerrado" ? "🔒" : ""}</div>
            <div class="relatorio-meta">${r.destino ?? ""} · ${despesasDoRelatorio.length} despesa(s)</div>
          </div>
          <div class="relatorio-total">R$ ${total.toFixed(2)}</div>
        </div>
        <div class="relatorio-body" id="body-${r.id}">
          <table><tbody>${despesasDoRelatorio.map(linhaDespesaSimples).join("") || "<tr><td>Nenhuma despesa ainda.</td></tr>"}</tbody></table>
          ${r.status === "aberto" ? `<div class="form-actions"><button class="btn btn-sm" data-encerrar="${r.id}">Encerrar relatório</button></div>` : ""}
        </div>
      </div>`;
  }).join("") || `<p class="page-subtitle">Nenhum relatório de viagem ainda.</p>`;

  document.querySelectorAll("[data-toggle]").forEach((h) => {
    h.addEventListener("click", () => document.getElementById(`body-${h.dataset.toggle}`).classList.toggle("open"));
  });
  document.querySelectorAll("[data-encerrar]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await updateDoc(doc(db, "relatoriosViagem", btn.dataset.encerrar), { status: "encerrado" });
      toast("Relatório encerrado.");
    });
  });
}

// ---------- REEMBOLSO ----------
const enviarParaReembolso = httpsCallable(functions, "enviarParaReembolso");

document.querySelectorAll("#section-reembolso [data-canal]").forEach((btn) => {
  btn.addEventListener("click", () => acionarReembolso(btn.dataset.canal));
});

document.getElementById("btn-enviar-reembolso").addEventListener("click", () => {
  if (state.selecionadas.size === 0) { toast("Selecione ao menos uma despesa pendente.", true); return; }
  const canal = confirm("OK = enviar por e-mail. Cancelar = enviar por WhatsApp.") ? "email" : "whatsapp";
  acionarReembolso(canal, Array.from(state.selecionadas));
});

async function acionarReembolso(canal, despesaIds) {
  try {
    const { data } = await enviarParaReembolso({ canal, despesaIds });
    toast(`${data.enviado} despesa(s) enviada(s) para reembolso por ${canal}.`);
    state.selecionadas.clear();
  } catch (err) {
    toast("Erro ao enviar para reembolso: " + err.message, true);
  }
}
