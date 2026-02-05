import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function json(res, status = 200) {
  return new Response(JSON.stringify(res), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-license-key"
    }
  });
}

export async function OPTIONS() {
  return json({ ok: true }, 200);
}

function validateEnv_() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY environment variable in Vercel.");
  }
}

function validateLicense_(request) {
  const secret = process.env.LICENSE_SECRET;
  if (!secret) return; // licensing disabled

  const provided = request.headers.get("x-license-key") || "";
  const allow = secret.split(",").map(s => s.trim()).filter(Boolean);
  if (!provided) throw new Error("Missing license key (x-license-key).");
  if (!allow.includes(provided)) throw new Error("Invalid license key.");
}

function normalizePayload_(payload) {
  const apps = payload?.data?.applications ?? [];
  const networking = payload?.data?.networking ?? [];
  const interviews = payload?.data?.interviews ?? [];
  const meta = payload?.meta ?? {};
  return { apps, networking, interviews, meta };
}

function safeString_(v, max = 500) {
  return String(v ?? "").slice(0, max);
}

export async function POST(request) {
  try {
    validateEnv_();
    validateLicense_(request);

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return json({ error: "Request body must be valid JSON." }, 400);
    }

    const { apps, networking, interviews, meta } = normalizePayload_(payload);
    const ghostedDays = Number(meta?.ghosted_days_threshold ?? 14);

    // Your wrapped schema object should look like:
    // const schema = { name: "...", schema: { ...actual json schema... } }
    // Ensure you have BOTH: schema.name and schema.schema
    if (!globalThis.schema || !globalThis.schema.name || !globalThis.schema.schema) {
      // If you defined schema as a local const, remove this block and just ensure it's defined below.
      // This is only here to catch the most common crash: schema is undefined.
    }

    // ---- IMPORTANT: make sure "schema" exists in this file scope ----
    // If your schema constant is named differently, update the next 3 lines accordingly.
    const schemaName = schema?.name;
    const innerSchema = schema?.schema;

    if (!schemaName || !innerSchema) {
      return json({ error: "Schema is missing. Ensure you have const schema = { name, schema }." }, 500);
    }

    // Slim + normalize inputs (prevents huge token usage)
    const slimApps = apps.slice(0, 300).map(a => ({
      company: a["Company Name"] ?? a.company ?? "",
      role: a["Role Title"] ?? a.role ?? "",
      status: a["Status"] ?? a.status ?? "",
      priority: a["Priority"] ?? a.priority ?? "",
      date_submitted: a["Date Submitted"] ?? a.date_submitted ?? "",
      deadline: a["Deadline"] ?? a.deadline ?? "",
      last_follow_up: a["Last Follow-Up Date"] ?? a.last_follow_up ?? "",
      next_action: a["Next Action Date"] ?? a.next_action ?? "",
      recruiter: a["Recruiter Name"] ?? a.recruiter ?? "",
      recruiter_email: a["Recruiter Email"] ?? a.recruiter_email ?? "",
      notes: safeString_(a["Notes"] ?? a.notes, 500),
      interest: a["Interest Level (1–5)"] ?? a.interest ?? ""
    }));

    const slimNetworking = networking.slice(0, 300).map(n => ({
      company: n["Company"] ?? "",
      contact: n["Contact Name"] ?? "",
      email: n["Email"] ?? "",
      where_met: n["Where Met"] ?? "",
      last_contact: n["Last Contact Date"] ?? "",
      next_follow_up: n["Next Follow-up Date"] ?? "",
      notes: safeString_(n["Notes"], 500)
    }));

    const slimInterviews = interviews.slice(0, 200).map(i => ({
      company: i["Company"] ?? "",
      role: i["Role"] ?? "",
      stage: i["Stage"] ?? "",
      date: i["Date"] ?? "",
      format: i["Format"] ?? "",
      topics: safeString_(i["Topics"], 300),
      rating: i["Self Rating (1–5)"] ?? "",
      follow_up_sent: i["Follow-up Sent?"] ?? "",
      notes: safeString_(i["Notes"], 400)
    }));

    const system = `
You are an internship application AI coach.
Given applications, networking, and interviews, produce:
- urgent actions (next 72 hours)
- next 7 days plan
- follow-ups with message drafts
- recruiter questions
- strategy insights
- interview prep plan
- risk flags

Rules:
- Be specific and time-oriented.
- Prioritize High priority + Submitted + No follow-up.
- Treat apps as ghosted if submitted > ${ghostedDays} days ago and no follow-up.
Return ONLY JSON matching the schema.
`.trim();

    const user = {
      meta: { ...meta, ghosted_days_threshold: ghostedDays },
      applications: slimApps,
      networking: slimNetworking,
      interviews: slimInterviews
    };

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) }
      ],
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          schema: innerSchema,
          strict: true
        }
      }
    });

    const out = response.output_text;
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch (e) {
      // If the model ever returns non-JSON, return it for debugging
      return json({ error: "Model returned non-JSON output.", raw: out }, 500);
    }

    return json(parsed, 200);
  } catch (err) {
    // Ensure we ALWAYS return JSON (so Apps Script shows the real error)
    return json({ error: err?.message ? String(err.message) : String(err) }, 500);
  }
}
