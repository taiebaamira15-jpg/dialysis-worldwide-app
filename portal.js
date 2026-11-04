// Dialysis Worldwide – espace centres partenaires.
// Shown instead of the main app when the signed-in account belongs to a partner dialysis centre.
// A centre account can't read the main database: everything here comes from portal_data(),
// which only returns that centre's own patients (booking essentials), sessions and earnings.
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const DAY = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
  const fdate = d => { if (!d) return "—"; const x = new Date(d + (d.length === 10 ? "T12:00:00" : "")); return isNaN(x) ? d : x.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }); };
  const fday = d => { const x = new Date(d + "T12:00:00"); return isNaN(x) ? "" : DAY[x.getDay()]; };
  const tnd = n => (Number(n) || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " TND";
  const DOCS = { passport: "Passeport", serology: "Sérologies (VHB, VHC, VIH)", labs: "Bilan sanguin récent", prescription: "Prescription de dialyse", report: "Compte rendu du néphrologue", consent: "Consentement / bon de réservation" };
  const STAGE = { docs: "En attente des documents", quote: "Devis envoyé", confirmed: "Confirmé", treatment: "En cours de séjour", done: "Séjour terminé" };
  const TRANSFER = { "None": "Aucun", "Taxi to/from sessions": "Taxi aller-retour pour les séances", "Airport + sessions": "Aéroport + séances", "Airport only": "Aéroport uniquement" };
  const REPLY = { accept: ["Accepté", "ok"], refuse: ["Refusé", "bad"], propose: ["Autres horaires proposés", "warn"] };

  const css = `
  #portal{min-height:100vh;background:var(--bg);color:var(--ink)}
  #portal header.pt{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px max(16px,env(safe-area-inset-left,0px));background:var(--surface);border-bottom:1px solid var(--line)}
  #portal header.pt .ttl{font-family:var(--f-display);font-weight:800;font-size:18px} #portal header.pt .ttl span{color:var(--brand)}
  #portal header.pt .who{color:var(--muted);font-size:13px} #portal header.pt .sp{flex:1}
  #portal main{max-width:980px;margin:0 auto;padding:18px 16px 60px}
  #portal .tabs{display:flex;gap:8px;margin:0 0 16px} #portal .tabs button{padding:8px 14px;border-radius:999px;border:1px solid var(--line);background:var(--surface);font-weight:700;cursor:pointer;color:var(--ink)}
  #portal .tabs button[aria-pressed=true]{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
  #portal .kp{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px}
  #portal .kp div{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px} #portal .kp b{display:block;font-size:22px;font-family:var(--f-display)} #portal .kp span{color:var(--muted);font-size:13px}
  #portal .card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
  #portal .card h3{margin:0;font-size:17px;font-family:var(--f-display)} #portal .meta{color:var(--muted);font-size:13px;margin-top:3px}
  #portal .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px 16px;margin:12px 0;font-size:14px} #portal .grid i{display:block;font-style:normal;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em;font-weight:700}
  #portal .chip{display:inline-block;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:700;background:var(--sunk);color:var(--ink)}
  #portal .chip.ok{background:var(--ok-soft);color:var(--ok)} #portal .chip.bad{background:var(--red-soft);color:var(--red)} #portal .chip.warn{background:var(--warn-soft);color:var(--warn)}
  #portal table{width:100%;border-collapse:collapse;font-size:14px} #portal td,#portal th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left} #portal th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  #portal td.n,#portal th.n{text-align:right;font-variant-numeric:tabular-nums}
  #portal .acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
  #portal .pbtn{padding:9px 14px;border-radius:9px;border:1px solid var(--line);background:var(--surface);font-weight:700;cursor:pointer;color:var(--ink);font-size:14px}
  #portal .pbtn.pri{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)} #portal .pbtn.dng{color:var(--red)}
  #portal .pbtn:disabled{opacity:.5;cursor:default}
  #portal textarea,#portal input{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)} #portal textarea{width:100%;box-sizing:border-box}
  #portal .form{margin-top:12px;padding:12px;border-radius:10px;background:var(--sunk)} #portal .form .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
  #portal .empty{color:var(--muted);text-align:center;padding:30px 10px}
  #portal .note{color:var(--muted);font-size:13px}
  #portal .scroll{overflow-x:auto}`;

  let sb, me, data = { patients: [], sessions: [], earnings: [] }, tab = "patients", open = null, busy = false;

  async function load() {
    const { data: d, error } = await sb.rpc("portal_data");
    if (error) throw error;
    data = d || data;
  }
  function root() { let r = document.getElementById("portal"); if (!r) { r = document.createElement("div"); r.id = "portal"; document.body.appendChild(r); } return r; }

  function sessionsOf(pid) { return data.sessions.filter(s => s.patientId === pid); }
  function replyChip(r) { if (!r || !REPLY[r.action]) return `<span class="chip warn">En attente de votre réponse</span>`; const [l, k] = REPLY[r.action]; return `<span class="chip ${k}">${l} · ${fdate((r.at || "").slice(0, 10))}</span>`; }

  function patientCard(p) {
    const ss = sessionsOf(p.id), r = p.centreReply;
    const docs = (p.docs || []).map(k => DOCS[k] || k);
    return `<section class="card" data-pid="${esc(p.id)}">
      <div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap"><div style="flex:1;min-width:200px"><h3>${esc(p.name || "Patient")}</h3>
        <div class="meta">${esc(p.nationality || "")}${p.nationality ? " · " : ""}${esc(STAGE[p.stage] || "")}</div></div>${replyChip(r)}</div>
      <div class="grid">
        <div><i>Arrivée</i>${fdate(p.arrival)}</div><div><i>Départ</i>${fdate(p.departure)}</div>
        <div><i>Traitement</i>${esc(p.mode || "HD")} · ${esc(p.hours || "4 h")}</div><div><i>Séances / semaine</i>${esc(p.perWeek || "—")}</div>
        <div><i>Hôtel</i>${esc(p.hotel || "—")}</div><div><i>Transfert</i>${esc(TRANSFER[p.transfer] || p.transfer || "—")}</div>
        <div style="grid-column:1/-1"><i>Dossier médical reçu</i>${docs.length ? docs.map(esc).join(" · ") : "Pas encore reçu"}</div>
      </div>
      ${ss.length ? `<div class="scroll"><table><thead><tr><th>Jour</th><th>Date</th><th>Heure</th><th>Statut</th></tr></thead><tbody>
        ${ss.map(s => `<tr><td>${fday(s.date)}</td><td>${fdate(s.date)}</td><td>${esc(s.time || "—")}${s.proposed && s.proposed.time ? ` <span class="note">(proposé : ${fdate(s.proposed.date)} ${esc(s.proposed.time)})</span>` : ""}</td><td>${s.status === "confirmed" ? '<span class="chip ok">Confirmée</span>' : s.status === "done" ? '<span class="chip">Faite</span>' : s.status === "cancelled" ? '<span class="chip bad">Annulée</span>' : '<span class="chip">Prévue</span>'}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="note">Les horaires de séance seront ajoutés par Dialyse Tunisie.${p.time ? " Heure souhaitée : " + esc(p.time) + "." : ""}</p>`}
      ${r && r.note ? `<p class="note">Votre message : « ${esc(r.note)} »</p>` : ""}
      ${p.stage === "done" ? "" : `<div class="acts">
        <button class="pbtn pri" data-act="accept">Accepter</button>
        <button class="pbtn" data-act="propose">Proposer d'autres horaires</button>
        <button class="pbtn dng" data-act="refuse">Refuser</button></div>`}
      ${open && open.pid === p.id ? form(p, ss, open.act) : ""}
    </section>`;
  }

  function form(p, ss, act) {
    const title = act === "accept" ? "Confirmer l'accueil de ce patient" : act === "refuse" ? "Refuser cette demande" : "Proposer d'autres horaires";
    return `<div class="form"><b>${title}</b>
      ${act === "propose" ? (ss.length ? ss.map(s => `<div class="row"><span style="min-width:110px">${fday(s.date)} ${fdate(s.date)}</span>
          <input type="date" data-sid="${esc(s.id)}" data-f="date" value="${esc(s.date)}"><input type="time" data-sid="${esc(s.id)}" data-f="time" value="${esc(s.time || "")}"></div>`).join("")
        : `<p class="note">Indiquez vos disponibilités dans le message ci-dessous.</p>`) : ""}
      <label class="note" style="display:block;margin-top:8px">Message pour Dialyse Tunisie ${act === "refuse" ? "(motif)" : "(facultatif)"}</label>
      <textarea id="pt_note" rows="3" placeholder="${act === "refuse" ? "Ex. : complet sur ces dates" : "Ex. : accueil à 7 h, prévoir 30 min avant la première séance"}"></textarea>
      <div class="acts"><button class="pbtn pri" data-send="${act}">${act === "accept" ? "Confirmer" : act === "refuse" ? "Envoyer le refus" : "Envoyer la proposition"}</button><button class="pbtn" data-cancel>Annuler</button></div></div>`;
  }

  function patientsView() {
    const now = new Date().toISOString().slice(0, 10);
    const list = data.patients.slice().sort((a, b) => (a.arrival || "9").localeCompare(b.arrival || "9"));
    const upcoming = list.filter(p => p.stage !== "done" && (!p.departure || p.departure >= now));
    const past = list.filter(p => !upcoming.includes(p));
    const waiting = upcoming.filter(p => !p.centreReply).length;
    return `<div class="kp"><div><b>${upcoming.length}</b><span>Patients à venir</span></div><div><b>${waiting}</b><span>En attente de votre réponse</span></div>
      <div><b>${data.sessions.filter(s => s.date >= now && s.status !== "cancelled").length}</b><span>Séances prévues</span></div></div>
      ${upcoming.map(patientCard).join("") || `<div class="card empty">Aucun patient à venir pour le moment. Les nouveaux patients apparaîtront ici dès que Dialyse Tunisie vous les adresse.</div>`}
      ${past.length ? `<h3 style="font-family:var(--f-display);margin:22px 0 10px">Séjours passés</h3>${past.map(patientCard).join("")}` : ""}`;
  }

  function earningsView() {
    const e = data.earnings;
    const earned = e.reduce((a, x) => a + Number(x.earned || 0), 0), com = e.reduce((a, x) => a + Number(x.commission || 0), 0);
    const owed = e.filter(x => x.status !== "paid").reduce((a, x) => a + Number(x.commission || 0), 0);
    return `<div class="kp"><div><b>${tnd(earned)}</b><span>Vos gains grâce à Dialyse Tunisie · ${e.length} patient${e.length > 1 ? "s" : ""}</span></div>
      <div><b>${e.reduce((a, x) => a + Number(x.sessions || 0), 0)}</b><span>Séances réalisées</span></div>
      <div><b>${tnd(com)}</b><span>Commission Dialyse Tunisie</span></div><div><b style="color:${owed > 0 ? "var(--warn)" : "var(--ok)"}">${tnd(owed)}</b><span>Commission restant à régler</span></div></div>
      <section class="card"><div class="scroll"><table><thead><tr><th>Date</th><th>Patient</th><th class="n">Séances</th><th class="n">Tarif</th><th class="n">Vos gains</th><th class="n">Commission</th><th>Règlement</th></tr></thead><tbody>
      ${e.map(x => `<tr><td>${fdate((x.date || "").slice(0, 10))}</td><td>${esc(x.name)}</td><td class="n">${esc(x.sessions)}</td><td class="n">${tnd(x.fee)}</td><td class="n"><b>${tnd(x.earned)}</b></td><td class="n">${tnd(x.commission)}</td><td>${x.status === "paid" ? '<span class="chip ok">Réglée</span>' : '<span class="chip warn">À régler</span>'}</td></tr>`).join("")}
      </tbody></table></div>${e.length ? "" : `<div class="empty">Les gains apparaîtront ici après le premier séjour d'un patient.</div>`}</section>
      <p class="note">Vos gains = nombre de séances × tarif convenu. Une question sur un montant ? Écrivez à contact@dialysetunisie.com.</p>`;
  }

  function render() {
    const r = root();
    r.innerHTML = `<header class="pt"><span class="ttl"><span>Dialyse</span> Tunisie · Espace partenaire</span><span class="who">${esc(me.centre)}</span><span class="sp"></span>
      <button class="pbtn" id="pt_ref">Actualiser</button><button class="pbtn" id="pt_out">Déconnexion</button></header>
      <main><div class="tabs"><button data-tab="patients" aria-pressed="${tab === "patients"}">Patients</button><button data-tab="earnings" aria-pressed="${tab === "earnings"}">Mes gains</button></div>
      ${tab === "patients" ? patientsView() : earningsView()}</main>`;
  }

  async function send(act, pid) {
    if (busy) return; const note = (document.getElementById("pt_note") || {}).value || "";
    if (act === "refuse" && !note.trim()) { alertNote("Indiquez le motif du refus."); return; }
    const times = act === "propose" ? sessionsOf(pid).map(s => ({ sessionId: s.id, date: (document.querySelector(`[data-sid="${CSS.escape(s.id)}"][data-f=date]`) || {}).value || s.date, time: (document.querySelector(`[data-sid="${CSS.escape(s.id)}"][data-f=time]`) || {}).value || s.time })) : [];
    if (act === "propose" && !times.length && !note.trim()) { alertNote("Indiquez vos disponibilités."); return; }
    busy = true;
    try {
      const { error } = await sb.rpc("portal_respond", { p_patient_id: pid, p_action: act, p_note: note, p_times: times });
      if (error) throw error;
      open = null; await load(); render(); flash(act === "accept" ? "Merci, l'accueil est confirmé." : act === "refuse" ? "Refus envoyé à Dialyse Tunisie." : "Proposition envoyée à Dialyse Tunisie.");
    } catch (e) { alertNote("Envoi impossible : " + (e.message || e)); } finally { busy = false; }
  }
  function alertNote(t) { const f = document.querySelector("#portal .form"); if (!f) return; let m = f.querySelector(".err"); if (!m) { m = document.createElement("p"); m.className = "err"; m.style.color = "var(--red)"; f.appendChild(m); } m.textContent = t; }
  function flash(t) { const d = document.createElement("div"); d.textContent = t; d.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--accent);color:var(--accent-ink);padding:10px 16px;border-radius:10px;z-index:50;font-weight:700"; document.body.appendChild(d); setTimeout(() => d.remove(), 2800); }

  window.dwPortal = async function (client, info) {
    sb = client; me = info || {};
    document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);
    document.title = "Espace partenaire · " + (me.centre || "Dialyse Tunisie");
    [...document.body.children].forEach(el => { if (el.id !== "portal" && el.tagName !== "SCRIPT") el.style.display = "none"; });
    root().innerHTML = `<main><p class="note" style="padding:40px;text-align:center">Chargement…</p></main>`;
    sb.functions.invoke("centre-portal", { body: { action: "joined" } }).catch(() => {});
    try { await load(); } catch (e) { root().innerHTML = `<main><div class="card">Impossible de charger votre espace : ${esc(e.message || e)}</div></main>`; return; }
    render();
    document.addEventListener("click", e => {
      if (!document.getElementById("portal")) return;
      const t = e.target.closest("[data-tab]"); if (t) { tab = t.dataset.tab; open = null; render(); return; }
      const a = e.target.closest("[data-act]"); if (a) { open = { pid: a.closest("[data-pid]").dataset.pid, act: a.dataset.act }; render(); const n = document.getElementById("pt_note"); if (n) n.focus(); return; }
      if (e.target.closest("[data-cancel]")) { open = null; render(); return; }
      const s = e.target.closest("[data-send]"); if (s) { send(s.dataset.send, s.closest("[data-pid]").dataset.pid); return; }
      if (e.target.id === "pt_ref") { load().then(render).catch(err => flash(String(err.message || err))); return; }
      if (e.target.id === "pt_out") { sb.auth.signOut().then(() => location.reload()); return; }
    });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !open) load().then(render).catch(() => {}); });
  };
})();
