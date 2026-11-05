// Dialysis Worldwide – centre-portal: invite a partner dialysis centre, remove its access, mark it joined,
// and (on every 5-minute cron tick) email centres about new patients and date/time changes.
// Emails are sent from contact@dialysetunisie.com (same Hostinger SMTP secrets as the "team" function).
import nodemailer from "npm:nodemailer@6";
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY"))!, { auth: { persistSession: false } });
const OWNER = "c6049114-f6d2-4b79-9862-5b4171810d3a";
const APP = "https://taiebaamira15-jpg.github.io/dialysis-worldwide-app/";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i;
const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

async function caller(req: Request) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await sb.auth.getUser(jwt);
  const u = data?.user; if (!u) return null;
  if (u.id === OWNER) return { id: u.id, email: u.email || "", role: "admin" };
  const { data: m } = await sb.from("team_members").select("role,status").eq("user_id", u.id).maybeSingle();
  return { id: u.id, email: u.email || "", role: m?.status === "active" ? m.role : "none" };
}

async function mail(to: string, subject: string, html: string, text: string) {
  const user = Deno.env.get("HOSTINGER_IMAP_USER") || "contact@dialysetunisie.com", pass = Deno.env.get("HOSTINGER_IMAP_PASSWORD");
  if (!pass) throw new Error("The mailbox password is not set in Supabase.");
  const t = nodemailer.createTransport({ host: Deno.env.get("HOSTINGER_SMTP_HOST") || "smtp.hostinger.com", port: 465, secure: true, auth: { user, pass } });
  await t.sendMail({ from: { name: "Dialyse Tunisie", address: user }, to, subject, html, text });
}

function inviteEmail(centre: string, name: string, link: string) {
  const hi = `Bonjour${name ? " " + name : ""},`;
  const intro = `Dialyse Tunisie vous ouvre un espace partenaire pour ${centre} : vous y voyez les patients que nous vous envoyons, leurs dates et horaires de séance, vous pouvez accepter ou proposer d'autres horaires, et suivre vos gains et nos commissions.`;
  const after = "Le lien ouvre l'espace : choisissez votre mot de passe et c'est prêt. Le lien est valable 24 heures.";
  const later = `Ensuite, votre espace est toujours disponible ici : ${APP}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#14262B;line-height:1.55">
   <p style="font-size:20px;font-weight:700"><span style="color:#D0101C">Dialyse</span> Tunisie · Espace centres partenaires</p>
   <p>${esc(hi)}</p><p>${esc(intro)}</p>
   <p style="margin:26px 0"><a href="${link}" style="background:#3B4248;color:#fff;text-decoration:none;padding:13px 22px;border-radius:8px;font-weight:700;display:inline-block">Ouvrir mon espace</a></p>
   <p style="color:#56696F">${esc(after)}</p><p style="color:#56696F">${esc(later)}</p>
   <p style="color:#8EA2A8;font-size:13px">Si vous n'attendiez pas cet e-mail, ignorez-le simplement.</p></div>`;
  const text = `${hi}\n\n${intro}\n\nOuvrir mon espace : ${link}\n\n${after}\n\n${later}`;
  return { subject: `Votre espace partenaire Dialyse Tunisie – ${centre}`, html, text };
}

// ---- notifications to partner centres (queued by the centre_notify trigger) ----
function isServer(req: Request) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY");
  if (key && jwt === key) return true;
  try { return JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role === "service_role"; } catch { return false; }
}
const visible = (p: any, centre: string) => !!p && p.center === centre && p.sentToCentre?.centre === centre && p.stage !== "done";
const frDate = (d?: string) => { if (!d) return "—"; const t = new Date(d + "T12:00:00Z"); return isNaN(+t) ? d : t.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }); };
const shortName = (n?: string) => { const w = String(n || "Patient").trim().split(/\s+/); return w.length > 1 ? `${w[0]} ${w[w.length - 1][0]}.` : w[0]; };

function notifyEmail(centre: string, contact: string, items: { kind: string; p: any; sessions: any[] }[]) {
  const news = items.filter((i) => i.kind === "new").length, changes = items.length - news;
  const subject = news && !changes ? (news > 1 ? `${news} nouveaux patients` : `Nouveau patient : ${shortName(items[0].p.name)}`) + ` – ${centre}`
    : !news ? (changes > 1 ? `Dates modifiées pour ${changes} patients` : `Dates modifiées : ${shortName(items[0].p.name)}`) + ` – ${centre}`
    : `Nouveaux patients et dates modifiées – ${centre}`;
  const blocks = items.map(({ kind, p, sessions }) => {
    const label = kind === "new" ? "Nouveau patient" : "Dates / horaires modifiés";
    const rows: [string, string][] = [
      ["Arrivée", frDate(p.arrival)], ["Départ", frDate(p.departure)],
      ["Traitement", `${p.mode || "HD"} · ${p.hours || "4 h"}`], ["Séances / semaine", String(p.perWeek || "—")],
    ];
    if (p.time) rows.push(["Horaire souhaité", String(p.time)]);
    const ses = sessions.filter((s) => s.status !== "cancelled").map((s) => `${frDate(s.date)}${s.time ? " à " + s.time : ""}`);
    return { label, name: shortName(p.name), rows, ses };
  });
  const hi = `Bonjour${contact ? " " + contact : ""},`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#14262B;line-height:1.55">
   <p style="font-size:20px;font-weight:700"><span style="color:#D0101C">Dialyse</span> Tunisie · ${esc(centre)}</p><p>${esc(hi)}</p>
   ${blocks.map((b) => `<div style="border:1px solid #DCE5E8;border-radius:10px;padding:14px 16px;margin:14px 0">
     <p style="margin:0 0 6px;font-size:12px;font-weight:700;text-transform:uppercase;color:${b.label.startsWith("Nouveau") ? "#D0101C" : "#B26A00"}">${b.label}</p>
     <p style="margin:0 0 8px;font-size:17px;font-weight:700">${esc(b.name)}</p>
     <table style="border-collapse:collapse;font-size:14px">${b.rows.map(([k, v]) => `<tr><td style="color:#56696F;padding:2px 14px 2px 0">${k}</td><td>${esc(v)}</td></tr>`).join("")}</table>
     ${b.ses.length ? `<p style="margin:10px 0 2px;color:#56696F;font-size:14px">Séances prévues :</p><ul style="margin:0;padding-left:18px;font-size:14px">${b.ses.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
   </div>`).join("")}
   <p>Merci de confirmer ou de proposer d'autres horaires dans votre espace partenaire.</p>
   <p style="margin:22px 0"><a href="${APP}" style="background:#3B4248;color:#fff;text-decoration:none;padding:13px 22px;border-radius:8px;font-weight:700;display:inline-block">Ouvrir mon espace</a></p>
   <p style="color:#8EA2A8;font-size:13px">Les coordonnées complètes du patient sont dans votre espace partenaire.</p></div>`;
  const text = `${hi}\n\n` + blocks.map((b) => `${b.label.toUpperCase()} : ${b.name}\n` + b.rows.map(([k, v]) => `${k} : ${v}`).join("\n") + (b.ses.length ? `\nSéances prévues :\n- ${b.ses.join("\n- ")}` : "")).join("\n\n")
    + `\n\nMerci de confirmer ou de proposer d'autres horaires dans votre espace partenaire : ${APP}`;
  return { subject, html, text };
}

async function teamEmail() {
  return (await sb.auth.admin.getUserById(OWNER)).data.user?.email || Deno.env.get("HOSTINGER_IMAP_USER") || "contact@dialysetunisie.com";
}

// the centre answered: email the team at once
async function flushReplies(rows: any[]) {
  let sent = 0;
  for (const r of rows) {
    const { data: rec } = await sb.from("records").select("data").eq("collection", "patients").eq("id", r.patient_id).maybeSingle();
    const p = rec?.data, a = p?.centreReply;
    if (p && a) {
      const L: Record<string, string> = { accept: "a accepté", refuse: "a refusé", propose: "propose d'autres horaires pour" };
      const subject = `${r.centre} ${L[a.action] || "a répondu pour"} ${shortName(p.name)}`;
      const times = (a.times || []).map((t: any) => `${frDate(t.date)}${t.time ? " à " + t.time : ""}`);
      const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#14262B;line-height:1.55">
       <p style="font-size:18px;font-weight:700">${esc(subject)}</p>
       <p>Patient : <b>${esc(p.name || "")}</b> · ${esc(frDate(p.arrival))} → ${esc(frDate(p.departure))}</p>
       ${a.note ? `<p>Message du centre : “${esc(a.note)}”</p>` : ""}
       ${times.length ? `<p>Horaires proposés :</p><ul>${times.map((x: string) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
       <p style="margin:22px 0"><a href="${APP}" style="background:#3B4248;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700;display:inline-block">Ouvrir Dialysis Worldwide</a></p>
       <p style="color:#8EA2A8;font-size:13px">Réponse envoyée par ${esc(a.by || r.centre)}.</p></div>`;
      const text = `${subject}\nPatient : ${p.name || ""} · ${frDate(p.arrival)} → ${frDate(p.departure)}` + (a.note ? `\nMessage : ${a.note}` : "") + (times.length ? `\nHoraires proposés :\n- ${times.join("\n- ")}` : "") + `\n\n${APP}`;
      await mail(await teamEmail(), subject, html, text); sent++;
    }
    await sb.from("centre_notify_queue").update({ sent_at: new Date().toISOString() }).eq("id", r.id);
  }
  return sent;
}

// "Send patient for confirmation": email the centre right away
async function sendPatient(pid: string) {
  const { data: rec } = await sb.from("records").select("data").eq("collection", "patients").eq("id", pid).maybeSingle();
  const p = rec?.data, centre = p?.sentToCentre?.centre;
  if (!p || !centre || p.center !== centre) throw new Error("Choose the centre and save the patient first.");
  const { data: users } = await sb.from("centre_users").select("email,name").eq("centre", centre).neq("status", "removed");
  if (!users?.length) throw new Error(`${centre} has no partner access yet. Invite the centre from the Centres page first.`);
  const { data: ses } = await sb.from("records").select("data").eq("collection", "sessions").eq("data->>patientId", pid);
  const sessions = (ses || []).map((x) => x.data).filter((x) => x.center === centre).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  for (const u of users) { const m = notifyEmail(centre, u.name || "", [{ kind: "new", p, sessions }]); await mail(u.email, m.subject, m.html, m.text); }
  return users.length;
}

async function flush() {
  const { data: all, error } = await sb.from("centre_notify_queue").select("id,centre,patient_id,kind,created_at").is("sent_at", null).order("id").limit(500);
  if (error) throw error;
  if (!all?.length) return { sent: 0 };
  const replies = await flushReplies(all.filter((r) => r.kind === "reply"));
  const q = all.filter((r) => r.kind !== "reply");
  if (!q.length) return { sent: replies };
  // wait until a patient has had no new change for 2 minutes, so a burst of edits makes one email
  const quiet = Date.now() - 2 * 60 * 1000, groups = new Map<string, any[]>();
  for (const r of q) { const k = r.centre + "\u0000" + r.patient_id; (groups.get(k) || groups.set(k, []).get(k)!).push(r); }
  const ready = [...groups.values()].filter((g) => Math.max(...g.map((r) => +new Date(r.created_at))) < quiet);
  if (!ready.length) return { sent: replies, waiting: groups.size };
  const byCentre = new Map<string, { ids: number[]; pid: string; kind: string }[]>();
  for (const g of ready) (byCentre.get(g[0].centre) || byCentre.set(g[0].centre, []).get(g[0].centre)!)
    .push({ ids: g.map((r) => r.id), pid: g[0].patient_id, kind: g.some((r) => r.kind === "new") ? "new" : "change" });
  let sent = 0;
  for (const [centre, list] of byCentre) {
    const ids = list.flatMap((l) => l.ids);
    const { data: pats } = await sb.from("records").select("id,data").eq("collection", "patients").in("id", list.map((l) => l.pid));
    const { data: ses } = await sb.from("records").select("data").eq("collection", "sessions").in("data->>patientId", list.map((l) => l.pid));
    const items = list.map((l) => ({ pid: l.pid, kind: l.kind, p: pats?.find((x) => x.id === l.pid)?.data, sessions: [] as any[] }))
      .filter((i) => visible(i.p, centre));
    for (const i of items) i.sessions = (ses || []).map((s) => s.data).filter((s) => s.patientId === i.pid && s.center === centre)
      .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
    if (items.length) {
      const { data: users } = await sb.from("centre_users").select("email,name").eq("centre", centre).neq("status", "removed");
      for (const u of users || []) { const m = notifyEmail(centre, u.name || "", items); await mail(u.email, m.subject, m.html, m.text); sent++; }
    }
    await sb.from("centre_notify_queue").update({ sent_at: new Date().toISOString() }).in("id", ids);
  }
  return { sent: sent + replies };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const action = String(b.action || "");
    // cron tick (mail_tick insert) or manual flush with the server key
    if ((b.table === "mail_tick" || b.table === "centre_notify_queue" || action === "flush") && isServer(req)) return json({ ok: true, ...(await flush()) });
    const me = await caller(req);
    if (!me) return json({ error: "Sign in again." }, 401);

    // a centre user finished setting its password
    if (action === "joined") {
      await sb.from("centre_users").update({ user_id: me.id, status: "active", joined_at: new Date().toISOString() }).eq("email", me.email.toLowerCase()).neq("status", "removed");
      return json({ ok: true });
    }

    if (!["admin", "staff"].includes(me.role)) return json({ error: "Only admins and staff can manage centre access." }, 403);

    if (action === "invite") {
      const email = String(b.email || "").trim().toLowerCase(), centre = String(b.centre || "").trim(), name = String(b.name || "").trim(), site = String(b.site || "TN");
      if (!EMAIL.test(email)) return json({ error: "Check the email address." }, 400);
      if (!centre) return json({ error: "Choose the centre." }, 400);
      const { data: tm } = await sb.from("team_members").select("email").eq("email", email).maybeSingle();
      if (tm) return json({ error: "This email is already in your team. Use a different email for the centre." }, 400);
      if (email === (await sb.auth.admin.getUserById(OWNER)).data.user?.email?.toLowerCase()) return json({ error: "That's your own email." }, 400);
      let { data, error } = await sb.auth.admin.generateLink({ type: "invite", email, options: { redirectTo: APP } });
      if (error && /already|registered|exists/i.test(error.message)) ({ data, error } = await sb.auth.admin.generateLink({ type: "magiclink", email, options: { redirectTo: APP } }));
      if (error || !data?.properties?.action_link) throw new Error("Couldn't create the invitation: " + (error?.message || "no link"));
      const { error: e2 } = await sb.from("centre_users").upsert({ email, user_id: data.user?.id || null, centre, site, name: name || null, status: "invited", invited_at: new Date().toISOString(), invited_by: me.id }, { onConflict: "email" });
      if (e2) throw e2;
      const m = inviteEmail(centre, name, data.properties.action_link);
      await mail(email, m.subject, m.html, m.text);
      return json({ ok: true });
    }

    if (action === "send") {
      const n = await sendPatient(String(b.patientId || ""));
      return json({ ok: true, sent: n });
    }

    if (action === "remove") {
      const email = String(b.email || "").trim().toLowerCase();
      const { error } = await sb.from("centre_users").update({ status: "removed" }).eq("email", email);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
