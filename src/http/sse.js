// http/sse.js — the SSE relay and usage extraction on the response path.
// Owns:
//   • streamResponse — forward an upstream event-stream to the client chunk-by-chunk
//     while parsing usage as it flows (backpressure-aware, client-disconnect-safe).
//   • parseSSEUsage — pull input/cache/model off message_start, output off message_delta.
//   • extractUsageFromBody — the non-streamed equivalent for a buffered JSON body.
// Written by the forward path (http/forward.js), read by accounting/* via the
// AccountManager it is handed. No req/res routing, no account selection.
//   covered by: the streaming path is driven through http/forward.js in
//   test/all-throttled-hold.test.mjs; the usage math is exercised via the
//   deck/ledger/tree suites (updateUsage rollups).

/**
 * Stream an SSE response to the client, parsing usage data along the way.
 */
export async function streamResponse(webStream, res, accountIndex, accountManager, streamLog, sessionId = null) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Client disconnected — stop reading from upstream
      if (res.destroyed) break;

      // Forward chunk immediately
      const ok = res.write(value);

      const text = decoder.decode(value, { stream: true });

      // Capture for logging
      if (streamLog) streamLog.push(text);

      // Parse SSE events for usage tracking
      sseBuffer += text;
      const events = sseBuffer.split('\n\n');
      sseBuffer = events.pop(); // keep incomplete event

      for (const event of events) {
        parseSSEUsage(event, accountIndex, accountManager, sessionId);
      }

      // Handle backpressure — also bail out if client disconnects,
      // because 'drain' will never fire on a destroyed socket
      if (!ok) {
        await new Promise(resolve => {
          res.once('drain', resolve);
          res.once('close', resolve);
        });
        if (res.destroyed) break;
      }
    }

    // Parse any remaining buffer
    if (sseBuffer.trim()) {
      parseSSEUsage(sseBuffer, accountIndex, accountManager, sessionId);
    }
  } finally {
    // Cancel upstream reader to stop consuming data nobody needs
    reader.cancel().catch(() => {});
    if (!res.writableEnded) res.end();
  }
}

export function parseSSEUsage(event, accountIndex, accountManager, sessionId = null) {
  const dataLine = event.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) return;

  try {
    const data = JSON.parse(dataLine.slice(6));
    if (data.type === 'message_start' && data.message?.usage) {
      // D-2169: input + cache tokens + model land on message_start. Output
      // tokens arrive on message_delta (no model — the binding remembers it).
      accountManager.updateUsage(
        accountIndex, data.message.usage.input_tokens || 0, 0, sessionId,
        { ..._cacheOpts(data.message.usage), model: data.message.model || null },
      );
    } else if (data.type === 'message_delta' && data.usage) {
      accountManager.updateUsage(accountIndex, 0, data.usage.output_tokens || 0, sessionId);
    }
  } catch {
    // not valid JSON, skip
  }
}

// D-2169: split a usage object's cache-creation into 5m vs 1h. When the API
// omits the breakdown, treat all cache-creation as 5m (Claude Code's default TTL).
function _cacheOpts(usage) {
  const cc = usage.cache_creation || {};
  let c5 = cc.ephemeral_5m_input_tokens;
  let c1 = cc.ephemeral_1h_input_tokens;
  if (c5 == null && c1 == null) { c5 = usage.cache_creation_input_tokens || 0; c1 = 0; }
  else { c5 = c5 || 0; c1 = c1 || 0; }
  return { cacheCreate5m: c5, cacheCreate1h: c1, cacheRead: usage.cache_read_input_tokens || 0 };
}

export function extractUsageFromBody(buffer, accountIndex, accountManager, sessionId = null) {
  try {
    const json = JSON.parse(buffer.toString());
    if (json.usage) {
      accountManager.updateUsage(
        accountIndex, json.usage.input_tokens || 0, json.usage.output_tokens || 0, sessionId,
        { ..._cacheOpts(json.usage), model: json.model || null },
      );
    }
  } catch {
    // not JSON or no usage
  }
}
