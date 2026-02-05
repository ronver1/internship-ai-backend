export function GET() {
  return new Response(JSON.stringify({ ok: true, service: "internship-ai-backend" }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
