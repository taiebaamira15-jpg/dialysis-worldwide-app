// Dialysis Worldwide – centre-portal: invite a partner dialysis centre, remove its access, mark it joined.
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const action = String(b.action || "");
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
