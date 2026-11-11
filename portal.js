// Dialysis Worldwide – espace centres partenaires.
// Shown instead of the main app when the signed-in account belongs to a partner dialysis centre.
// A centre account can't read the main database: everything here comes from portal_data(),
// which only returns that centre's own patients (booking essentials), sessions, invoices and earnings.
// It refreshes itself: portal_stamp() is checked every 15 s and the page reloads its data when something changed.
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
  #portal .note{color:var(--muted);font-size:13px;background:none;border:0;padding:0;border-radius:0;box-shadow:none}
  #portal .scroll{overflow-x:auto}`;

  let sb, me, data = { patients: [], sessions: [], invoices: [], earnings: [] }, tab = "patients", open = null, busy = false, stamp = null, fresh = new Set();

  async function load() {
    const { data: d, error } = await sb.rpc("portal_data");
    if (error) throw error;
    const before = new Set((data.invoices || []).map(i => i.id + ":" + i.status));
    data = Object.assign({ patients: [], sessions: [], invoices: [], earnings: [] }, d || {});
    if (stamp !== null) fresh = new Set((data.invoices || []).filter(i => !before.has(i.id + ":" + i.status)).map(i => i.id));
  }
  // live: every 15 s ask the database whether anything changed for this centre (tiny call), reload only then
  async function tick() {
    if (document.visibilityState !== "visible" || open || busy) return;
    const a = document.activeElement; if (a && /INPUT|TEXTAREA/.test(a.tagName)) return;
    const { data: s, error } = await sb.rpc("portal_stamp");
    if (error) return;
    if (stamp === null) { stamp = s; return; }
    if (s !== stamp) { stamp = s; await load(); render(); flash(fresh.size ? "Nouvelle facture ajoutée par Dialyse Tunisie" : "Mis à jour"); }
  }
  function root() { let r = document.getElementById("portal"); if (!r) { r = document.createElement("div"); r.id = "portal"; document.body.appendChild(r); } return r; }

  function sessionsOf(pid) { return data.sessions.filter(s => s.patientId === pid); }
  function replyChip(r) { if (!r || !REPLY[r.action]) return `<span class="chip warn">En attente de votre réponse</span>`; const [l, k] = REPLY[r.action]; return `<span class="chip ${k}">${l} · ${fdate((r.at || "").slice(0, 10))}</span>`; }

  async function openFile(pid, i) {
    const p = data.patients.find(x => x.id === pid), f = p && (p.files || [])[i]; if (!f) return;
    const w = window.open("", "_blank");
    const { data: u, error } = await sb.storage.from("centre-files").createSignedUrl(f.path, 300);
    if (error) { if (w) w.close(); flash("Impossible d'ouvrir le document : " + error.message); return; }
    if (w) w.location = u.signedUrl; else location.href = u.signedUrl;
  }

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
        ${(p.files || []).length ? `<div style="grid-column:1/-1"><i>Documents envoyés par Dialyse Tunisie</i>${p.files.map((f, i) => `<a href="#" data-file="${i}" style="margin-right:12px">📄 ${esc(f.name)}</a>`).join("")}</div>` : ""}
      </div>
      ${ss.length ? `<div class="scroll"><table><thead><tr><th>Jour</th><th>Date</th><th>Heure</th><th>Statut</th></tr></thead><tbody>
        ${ss.map(s => `<tr><td>${fday(s.date)}</td><td>${fdate(s.date)}</td><td>${esc(s.time || "—")}${s.proposed && s.proposed.time ? ` <span class="note">(proposé : ${fdate(s.proposed.date)} ${esc(s.proposed.time)})</span>` : ""}</td><td>${s.status === "confirmed" ? '<span class="chip ok">Confirmée</span>' : s.status === "done" ? '<span class="chip">Faite</span>' : s.status === "cancelled" ? '<span class="chip bad">Annulée</span>' : '<span class="chip">Prévue</span>'}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="note">Les horaires de séance seront ajoutés par Dialyse Tunisie.${p.time ? " Heure souhaitée : " + esc(p.time) + "." : ""}</p>`}
      ${(data.invoices || []).filter(i => i.patientId === p.id).map(i => `<p class="note" style="margin:8px 0 0">🧾 Facture <b>${esc(i.number || "")}</b> · ${fdate(i.issued)} · ${money(i.total, i.currency)} · vos gains ${tnd(i.earned)} · ${invStatus(i)}${fresh.has(i.id) ? ' <span class="chip ok">Nouveau</span>' : ""}</p>`).join("")}
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

  const invStatus = i => i.status === "paid" ? '<span class="chip ok">Payée</span>' : '<span class="chip warn">En attente de paiement</span>';
  const money = (n, c) => (Number(n) || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + (c === "EUR" ? "€" : (c || ""));
  function invoicesView() {
    const l = data.invoices || [], sum = (k, x = l) => x.reduce((a, i) => a + Number(i[k] || 0), 0), paid = l.filter(i => i.status === "paid");
    return `<div class="kp"><div><b>${l.length}</b><span>Factures de vos patients</span></div>
      <div><b>${tnd(sum("earned"))}</b><span>Vos gains sur ces factures</span></div>
      <div><b>${tnd(sum("earned", paid))}</b><span>Dont déjà payé par les patients</span></div>
      <div><b>${sum("sessions")}</b><span>Séances facturées</span></div></div>
      <section class="card"><div class="scroll"><table><thead><tr><th>Facture</th><th>Date</th><th>Patient</th><th class="n">Séances</th><th class="n">Montant facturé</th><th class="n">Commission</th><th class="n">Vos gains</th><th>Paiement</th></tr></thead><tbody>
      ${l.map(i => `<tr${fresh.has(i.id) ? ' style="background:var(--ok-soft)"' : ""}><td><b>${esc(i.number || "—")}</b>${fresh.has(i.id) ? ' <span class="chip ok">Nouveau</span>' : ""}</td><td>${fdate(i.issued)}</td><td>${esc(i.name)}</td><td class="n">${esc(i.sessions)}</td>
        <td class="n">${money(i.total, i.currency)}${i.currency !== "TND" ? `<div style="font-size:11px;color:var(--muted)">${tnd(i.paidTnd)}</div>` : ""}</td>
        <td class="n">${tnd(i.commission)}<div style="font-size:11px;color:var(--muted)">${esc(i.rate)} %</div></td><td class="n"><b>${tnd(i.earned)}</b></td><td>${invStatus(i)}${i.paidAt ? `<div class="note">${fdate(String(i.paidAt).slice(0, 10))}</div>` : ""}</td></tr>`).join("")}
      </tbody></table></div>${l.length ? "" : `<div class="empty">Les factures de vos patients apparaîtront ici dès que Dialyse Tunisie les crée.</div>`}</section>
      <p class="note">Mis à jour automatiquement. Calcul : commission = (montant payé en TND − ${l[0] ? tnd(l[0].fee) : "tarif"} × séances) × taux. Vos gains = montant payé − commission.</p>`;
  }

  function earningsView() {
    const e = data.earnings, sum = (k, l = e) => l.reduce((a, x) => a + Number(x[k] || 0), 0);
    const owed = sum("commission", e.filter(x => x.status !== "paid"));
    return `<div class="kp"><div><b>${tnd(sum("earned"))}</b><span>Vos gains grâce à Dialyse Tunisie · ${e.length} patient${e.length > 1 ? "s" : ""}</span></div>
      <div><b>${tnd(sum("paid"))}</b><span>Payé par les patients · ${sum("sessions")} séances</span></div>
      <div><b>${tnd(sum("commission"))}</b><span>Commission Dialyse Tunisie</span></div><div><b style="color:${owed > 0 ? "var(--warn)" : "var(--ok)"}">${tnd(owed)}</b><span>Commission restant à régler</span></div></div>
      <section class="card"><div class="scroll"><table><thead><tr><th>Date</th><th>Patient</th><th class="n">Séances</th><th class="n">Payé par le patient</th><th class="n">Commission</th><th class="n">Vos gains</th><th>Règlement</th></tr></thead><tbody>
      ${e.map(x => `<tr><td>${fdate((x.date || "").slice(0, 10))}</td><td>${esc(x.name)}</td><td class="n">${esc(x.sessions)}</td><td class="n">${tnd(x.paid)}</td><td class="n">${tnd(x.commission)}<div style="font-size:11px;color:var(--muted)">${esc(x.rate)} % de ${tnd(Number(x.paid || 0) - Number(x.fee || 0) * Number(x.sessions || 0))}</div></td><td class="n"><b>${tnd(x.earned)}</b></td><td>${x.status === "paid" ? '<span class="chip ok">Réglée</span>' : '<span class="chip warn">À régler</span>'}</td></tr>`).join("")}
      </tbody></table></div>${e.length ? "" : `<div class="empty">Les gains apparaîtront ici après le premier séjour d'un patient.</div>`}</section>
      <p class="note">Calcul : commission = (montant payé par le patient − ${e[0] ? tnd(e[0].fee) : "tarif"} × séances) × taux de commission. Vos gains = montant payé − commission. Une question sur un montant ? Écrivez à contact@dialysetunisie.com.</p>`;
  }

  function render() {
    const r = root();
    r.innerHTML = `<header class="pt"><span class="ttl"><span>Dialyse</span> Tunisie · Espace partenaire</span><span class="who">${esc(me.centre)}</span><span class="sp"></span>
      <button class="pbtn" id="pt_ref">Actualiser</button><button class="pbtn" id="pt_out">Déconnexion</button></header>
      <main><div class="tabs"><button data-tab="patients" aria-pressed="${tab === "patients"}">Patients</button><button data-tab="invoices" aria-pressed="${tab === "invoices"}">Factures${(data.invoices || []).length ? " (" + data.invoices.length + ")" : ""}</button><button data-tab="earnings" aria-pressed="${tab === "earnings"}">Mes gains</button></div>
      ${tab === "patients" ? patientsView() : tab === "invoices" ? invoicesView() : earningsView()}</main>`;
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
    [...document.body.children].forEach(el => { if (el.id !== "portal" && el.id !== "splash" && el.tagName !== "SCRIPT") el.style.display = "none"; });
    root().innerHTML = `<main><p class="note" style="padding:40px;text-align:center">Chargement…</p></main>`;
    sb.functions.invoke("centre-portal", { body: { action: "joined" } }).catch(() => {});
    try { await load(); } catch (e) { root().innerHTML = `<main><div class="card">Impossible de charger votre espace : ${esc(e.message || e)}</div></main>`; window.dwSplashDone && window.dwSplashDone(); return; }
    render(); requestAnimationFrame(() => window.dwSplashDone && window.dwSplashDone());
    document.addEventListener("click", e => {
      if (!document.getElementById("portal")) return;
      const t = e.target.closest("[data-tab]"); if (t) { tab = t.dataset.tab; open = null; render(); return; }
      const a = e.target.closest("[data-act]"); if (a) { open = { pid: a.closest("[data-pid]").dataset.pid, act: a.dataset.act }; render(); const n = document.getElementById("pt_note"); if (n) n.focus(); return; }
      const fl = e.target.closest("[data-file]"); if (fl) { e.preventDefault(); openFile(fl.closest("[data-pid]").dataset.pid, Number(fl.dataset.file)); return; }
      if (e.target.closest("[data-cancel]")) { open = null; render(); return; }
      const s = e.target.closest("[data-send]"); if (s) { send(s.dataset.send, s.closest("[data-pid]").dataset.pid); return; }
      if (e.target.id === "pt_ref") { load().then(render).catch(err => flash(String(err.message || err))); return; }
      if (e.target.id === "pt_out") { sb.auth.signOut().then(() => location.reload()); return; }
    });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !open) load().then(render).catch(() => {}); });
    tick(); setInterval(() => tick().catch(() => {}), 15000);
  };
})();
