// api/recommendations.js
import OpenAI from "openai";

/**
 * REQUIRED ENV VARS (Vercel -> Project -> Settings -> Environment Variables)
 * - OPENAI_API_KEY
 *
 * OPTIONAL:
 * - LICENSE_SECRET   (comma-separated allowlist: "KEY1,KEY2")
 */

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

/**
 * WRAPPED SCHEMA (your style)
 * OpenAI expects:
 *   text.format.name   -> schema.name
 *   text.format.schema -> schema.schema   (the inner raw JSON Schema)
 */
const schema = {
  name: "internship_ai_recommendations",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      urgent_actions: { type: "array", items: { type: "string" } },
      next_7_days_plan: { type: "array", items: { type: "string" } },
      follow_ups: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            company: { type: "string" },
            suggested_date: { type: "string" },
            reason: { type: "string" },
            message_draft: { type: "string" }
          },
          required: ["company", "suggested_date", "reason", "message_draft"]
        }
      },
      recruiter_questions: { type: "array", items: { type: "string" } },
      strategy_insights: { type: "array", items: { type: "string" } },
      interview_prep: { type: "array", items: { type: "string" } },
      risk_flags: { type: "array", items: { type: "string" } }
    },
    required: [
      "summary",
      "urgent_actions",
      "next_7_days_plan",
      "follow_ups",
      "recruiter_questions",
      "strategy_insights",
      "interview_prep",
      "risk_flags"
    ]
  }
};

function requireEnv_() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY in Vercel environment variables.");
  }
}

function validateLicense_(request) {
  const secret = process.env.LICENSE_SECRET;
  if (!secret) return; // licensing disabled

  const provided = (request.headers.get("x-license-key") || "").trim();
  if (!provided) throw new Error("Missing license key (x-license-key header).");

  const allow = secret.split(",").map(s => s.trim()).filter(Boolean);
  if (!allow.includes(provided)) throw new Error("Invalid license key.");
}

function safeString_(v, max = 500) {
  return String(v ?? "").slice(0, max);
}

function normalizePayload_(payload) {
  const apps = payload?.data?.applications ?? [];
  const networking = payload?.data?.networking ?? [];
  const interviews = payload?.data?.interviews ?? [];
  const meta = payload?.meta ?? {};
  return { apps, networking, interviews, meta };
}

function toISODateString_(d) {
  // Accepts Date objects or strings; returns string safely
  if (!d) return "";
  if (d instanceof Date && !isNaN(d.getTime())) return d.toISOString();
  return String(d);
}

export async function POST(request) {
  try {
    requireEnv_();
    validateLicense_(request);

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Request body must be valid JSON." }, 400);
    }

    const { apps, networking, interviews, meta } = normalizePayload_(payload);
    const ghostedDays = Number(meta?.ghosted_days_threshold ?? 14);

    // Slim down input so it stays fast/cheap and avoids token blowups
    const slimApps = apps.slice(0, 300).map(a => ({
      company: a["Company Name"] ?? a.company ?? "",
      role: a["Role Title"] ?? a.role ?? "",
      status: a["Status"] ?? a.status ?? "",
      priority: a["Priority"] ?? a.priority ?? "",
      date_submitted: toISODateString_(a["Date Submitted"] ?? a.date_submitted ?? ""),
      deadline: toISODateString_(a["Deadline"] ?? a.deadline ?? ""),
      last_follow_up: toISODateString_(a["Last Follow-Up Date"] ?? a.last_follow_up ?? ""),
      next_action: toISODateString_(a["Next Action Date"] ?? a.next_action ?? ""),
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
      last_contact: toISODateString_(n["Last Contact Date"] ?? ""),
      next_follow_up: toISODateString_(n["Next Follow-up Date"] ?? ""),
      notes: safeString_(n["Notes"], 500)
    }));

    const slimInterviews = interviews.slice(0, 200).map(i => ({
      company: i["Company"] ?? "",
      role: i["Role"] ?? "",
      stage: i["Stage"] ?? "",
      date: toISODateString_(i["Date"] ?? ""),
      format: i["Format"] ?? "",
      topics: safeString_(i["Topics"], 300),
      rating: i["Self Rating (1–5)"] ?? "",
      follow_up_sent: i["Follow-up Sent?"] ?? "",
      notes: safeString_(i["Notes"], 400)
    }));

    const system = `
You are an internship application AI coach.

Given a user's applications, networking, and interviews, produce:
- urgent_actions (next 72 hours)
- next_7_days_plan
- follow_ups (each with a message draft)
- recruiter_questions
- strategy_insights
- interview_prep
- risk_flags

Rules:
- Be specific and time-oriented (e.g., "today", "in 2 days", "this Friday").
- Prioritize High priority + Submitted + No follow-up first.
- Treat an application as "ghosted risk" if submitted > ${ghostedDays} days ago and no follow-up is recorded.
- If key info is missing (recruiter email, submission date, etc.), add a risk_flag and suggest what to fill in.
Return ONLY JSON that matches the schema exactly.
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
          name: schema.name,       // REQUIRED
          schema: schema.schema,   // inner JSON schema only
          strict: true
        }
      }
    });

    const out = response.output_text;

    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch {
      // If model output ever isn't valid JSON, return it for debugging
      return json({ error: "Model returned non-JSON output.", raw: out }, 500);
    }

    return json(parsed, 200);
  } catch (err) {
    // Always return readable error JSON to Apps Script
    return json({ error: String(err?.message || err) }, 500);
  }
}
