import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function json(res, status = 200) {
  return new Response(JSON.stringify(res), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

function validateLicense(request) {
  // OPTIONAL: If you want licensing, set LICENSE_SECRET in Vercel
  // and require client to send x-license-key.
  const secret = process.env.LICENSE_SECRET;
  if (!secret) return { ok: true, mode: "no_license" };

  const provided = request.headers.get("x-license-key") || "";
  if (!provided) return { ok: false, reason: "Missing license key." };

  // simplest pattern: secret is a comma-separated allowlist
  const allow = secret.split(",").map(s => s.trim()).filter(Boolean);
  if (!allow.includes(provided)) return { ok: false, reason: "Invalid license key." };

  return { ok: true, mode: "license_ok" };
}

function normalizeInput(payload) {
  const apps = payload?.data?.applications ?? [];
  const networking = payload?.data?.networking ?? [];
  const interviews = payload?.data?.interviews ?? [];
  const meta = payload?.meta ?? {};
  return { apps, networking, interviews, meta };
}

export async function POST(request) {
  try {
    requireEnv("OPENAI_API_KEY");

    const lic = validateLicense(request);
    if (!lic.ok) return json({ error: lic.reason }, 401);

    const payload = await request.json();
    const { apps, networking, interviews, meta } = normalizeInput(payload);

    // Keep token usage reasonable: truncate very long notes fields.
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
      notes: String(a["Notes"] ?? a.notes ?? "").slice(0, 500),
      interest: a["Interest Level (1–5)"] ?? a.interest ?? ""
    }));

    const slimNetworking = networking.slice(0, 300).map(n => ({
      company: n["Company"] ?? "",
      contact: n["Contact Name"] ?? "",
      email: n["Email"] ?? "",
      where_met: n["Where Met"] ?? "",
      last_contact: n["Last Contact Date"] ?? "",
      next_follow_up: n["Next Follow-up Date"] ?? "",
      notes: String(n["Notes"] ?? "").slice(0, 500)
    }));

    const slimInterviews = interviews.slice(0, 200).map(i => ({
      company: i["Company"] ?? "",
      role: i["Role"] ?? "",
      stage: i["Stage"] ?? "",
      date: i["Date"] ?? "",
      format: i["Format"] ?? "",
      topics: String(i["Topics"] ?? "").slice(0, 300),
      rating: i["Self Rating (1–5)"] ?? "",
      follow_up_sent: i["Follow-up Sent?"] ?? "",
      notes: String(i["Notes"] ?? "").slice(0, 400)
    }));

    const ghostedDays = meta.ghosted_days_threshold ?? 14;

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

    const system = `
You are an internship application AI coach.
Given the user's applications, networking, and interview history,
generate an actionable plan with follow-ups, outreach drafts, and insights.

Rules:
- Be concrete and time-oriented (use "today", "in 2 days", "this Friday" style).
- Prefer high priority + submitted + no follow-up applications first.
- Identify ghosted items: submitted > ${ghostedDays} days ago with no follow-up.
- Output must match the JSON schema exactly.
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
      json_schema: schema
    }
  }
});

// Responses API returns JSON as text in this mode
const parsed = JSON.parse(response.output_text);

    return json(parsed, 200);
  } catch (err) {
    return json({ error: String(err?.message || err) }, 500);
  }
}
