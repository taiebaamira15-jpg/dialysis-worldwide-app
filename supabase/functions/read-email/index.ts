// Dialysis Worldwide – read-email: reads a patient's email and returns the details for a new patient file.
// Uses Google Gemini. Secret needed in Supabase → Edge Functions → Secrets: GEMINI_API_KEY (optional GEMINI_MODEL).
// Only signed-in team members can use it; the email text is not stored by this function.
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY"))!, { auth: { persistSession: false } });
const OWNER = "c6049114-f6d2-4b79-9862-5b4171810d3a";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const API = "https://generativelanguage.googleapis.com/v1beta";

async function isTeam(req: Request) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const { data } = await sb.auth.getUser(jwt);
  const u = data?.user; if (!u) return false;
  if (u.id === OWNER) return true;
  const { data: m } = await sb.from("team_members").select("status").eq("user_id", u.id).maybeSingle();
  return m?.status === "active";
}

// pick a current Flash model (Google renames them often); GEMINI_MODEL overrides
let picked = "";
async function model(key: string) {
  if (Deno.env.get("GEMINI_MODEL")) return Deno.env.get("GEMINI_MODEL")!;
  if (picked) return picked;
  const r = await fetch(`${API}/models?pageSize=200&key=${key}`);
  if (!r.ok) throw new Error(r.status === 400 || r.status === 403 ? "The Gemini key isn't valid. Check GEMINI_API_KEY in Supabase." : "Gemini is not reachable (" + r.status + ").");
  const names: string[] = ((await r.json()).models || [])
    .filter((m: any) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m: any) => String(m.name).replace(/^models\//, ""))
    .filter((n: string) => /flash/.test(n) && !/image|tts|audio|live|thinking|exp|preview|embed/.test(n));
  const score = (n: string) => (n === "gemini-flash-latest" ? 1000 : 0) + (/lite/.test(n) ? -50 : 0) + parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [, "0"])[1]) * 10 - (/-\d{3}$/.test(n) ? 1 : 0);
  names.sort((a, b) => score(b) - score(a));
  if (!names.length) throw new Error("No Gemini Flash model is available for this key.");
  return (picked = names[0]);
}

const FIELDS = {
  name: "patient's full name (the patient, not a relative writing for them)",
  email: "patient's or contact's email address",
  phone: "phone / WhatsApp number in international format, e.g. +33612345678",
  nationality: "nationality or country of residence, in English (e.g. French, German, Belgian)",
  lang: "language of the email: fr | en | de | ar | it | other",
  arrival: "first day in the country, YYYY-MM-DD",
  departure: "last day in the country, YYYY-MM-DD",
  perWeek: "dialysis sessions per week, number (usually 3)",
  hours: "session length: one of 3 h | 3.5 h | 4 h | 4.5 h | 5 h",
  mode: "HD or HDF",
  time: "preferred session time HH:MM (24 h), e.g. morning = 07:00",
  city: "city or area where they will stay (e.g. Sousse, Hammamet, Djerba, Tunis)",
  hotel: "hotel name",
  transfer: "one of: None | Taxi to/from sessions | Airport + sessions | Airport only",
  notes: "one or two short lines for the team: companion, medical details mentioned (hepatitis status, access type, dry weight), special needs, questions asked",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!(await isTeam(req))) return json({ error: "Sign in again." }, 401);
    const key = Deno.env.get("GEMINI_API_KEY");
    if (!key) return json({ error: "The email reader isn't set up yet: add GEMINI_API_KEY in Supabase → Edge Functions → Secrets." }, 400);
    const b = await req.json().catch(() => ({}));
    const text = String(b.text || "").trim().slice(0, 20000);
    if (text.length < 20) return json({ error: "Paste the full email text." }, 400);
    const today = new Date().toISOString().slice(0, 10);
    const prompt = `You prepare a patient file for a holiday-dialysis travel service. Read the email (or message thread) below and extract the details.
Today is ${today}. Rules: use only what is written; leave a field as "" (or null for numbers) when it isn't stated; never guess.
Dates: convert to YYYY-MM-DD; if the year is missing, use the next future occurrence; "from 3 to 17 March" → arrival 3 March, departure 17 March; a duration ("2 weeks from 3 March") → compute the departure.
If the sender writes for someone else (son, wife, nurse, agency), "name" is the patient's name and mention the sender in notes.
Fields:
${Object.entries(FIELDS).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

EMAIL:
${text}`;
    const props: Record<string, unknown> = {};
    for (const k of Object.keys(FIELDS)) props[k] = k === "perWeek" ? { type: "integer", nullable: true } : { type: "string" };
    const m = await model(key);
    const r = await fetch(`${API}/models/${m}:generateContent?key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: { type: "object", properties: props } },
      }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 404) picked = "";
      throw new Error(r.status === 429 ? "Too many emails read in a short time. Wait a minute and try again." : "Gemini error: " + (out?.error?.message || r.status));
    }
    const raw = out?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "{}";
    let d: Record<string, any> = {};
    try { d = JSON.parse(raw.replace(/^```(json)?|```$/g, "")); } catch { throw new Error("Couldn't read the answer. Try again."); }
    // tidy
    const clean: Record<string, any> = {};
    for (const k of Object.keys(FIELDS)) { const v = d[k]; if (v !== null && v !== undefined && String(v).trim() !== "") clean[k] = typeof v === "string" ? v.trim() : v; }
    for (const k of ["arrival", "departure"]) if (clean[k] && !/^\d{4}-\d{2}-\d{2}$/.test(clean[k])) delete clean[k];
    if (clean.time && !/^\d{1,2}:\d{2}$/.test(clean.time)) delete clean.time;
    if (clean.hours && !["3 h", "3.5 h", "4 h", "4.5 h", "5 h"].includes(clean.hours)) delete clean.hours;
    if (clean.mode && !["HD", "HDF"].includes(String(clean.mode).toUpperCase())) delete clean.mode; else if (clean.mode) clean.mode = String(clean.mode).toUpperCase();
    if (clean.transfer && !["None", "Taxi to/from sessions", "Airport + sessions", "Airport only"].includes(clean.transfer)) delete clean.transfer;
    if (clean.lang && !["fr", "en", "de", "ar", "it"].includes(clean.lang)) delete clean.lang;
    if (clean.perWeek != null) { const n = Math.round(Number(clean.perWeek)); if (n >= 1 && n <= 6) clean.perWeek = n; else delete clean.perWeek; }
    return json({ ok: true, model: m, patient: clean });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
