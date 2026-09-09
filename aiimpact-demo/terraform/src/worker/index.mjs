// Placeholder. Consumes the generation queue.
//
// Steps, in order:
//   1. mark job running
//   2. read the Anthropic key from Secrets Manager (cache across invocations)
//   3. call the Messages API with structured output -- the model returns JSON
//      fields, never HTML. See README section 5.1: pages are served from the
//      organisation's own domain, so the renderer must be incapable of
//      emitting script rather than filtering for it.
//   4. render the fixed template from those fields
//   5. PUT to s3://$SITES_BUCKET/sites/{slug}/index.html
//   6. mark job done with the public URL
//
// Use prompt caching: the system prompt is byte-identical across all
// participants, so it caches after the first call and reads back at roughly a
// tenth of the input price.
//
// Return ReportBatchItemFailures on error so SQS redrives to the DLQ.

export const handler = async (event) => {
  for (const record of event.Records ?? []) {
    console.log("received job", record.messageId);
  }
  return { batchItemFailures: [] };
};
