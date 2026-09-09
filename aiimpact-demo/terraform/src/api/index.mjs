// Placeholder. Routes exist so the stack deploys and can be smoke-tested;
// business logic is not implemented yet.
//
// Contract (see ../../README.md section 7):
//   POST /redeem          { code }            -> { token, slug }
//   POST /generate        { fields }          -> { job_id }
//   GET  /status/{job_id}                     -> { status, url? }
//   GET  /me                                  -> { slug, remaining }
//
// Invariants this handler must enforce:
//   - reject when participants.generation_count >= MAX_GENERATIONS
//   - slug is assigned once and never changes
//   - a code may only be redeemed once

export const handler = async (event) => {
  const route = event.requestContext?.routeKey ?? "unknown";
  return {
    statusCode: 501,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      error: "not_implemented",
      route,
      message: "Infrastructure is deployed; handler logic is pending.",
    }),
  };
};
