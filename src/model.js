// Model-id helpers + streaming request-body field parsers, shared by the request
// path (http/forward) and account selection. Dependency-free so the forward path
// can peek a request's model/advisor-model/effort without pulling in the
// account-manager graph. Lifted from upstream (karpeleslab #64/#66/#70/#98/#99):
// the streaming finders replace the per-request whole-body JSON.parse and are
// byte-exact (never mistake a `"model"` nested in conversation text for the real
// top-level field). Upstream's routing POLICY (route pins, per-family weekly
// buckets) is deliberately NOT lifted — core/selection owns picking.
//   • covered by test/model.test.mjs, test/advisor-routing.test.mjs.

// The model "family" a request belongs to — a stable lowercase tag; unknown ids
// fall back to 'other'. The premium (7d_oi) admission gate is config-driven
// (core/bench isPremiumModel), not this classifier; this is the descriptive tag.
export function modelFamily(model) {
  if (typeof model !== 'string' || !model) return 'other';
  if (/fable/i.test(model)) return 'fable';
  if (/sonnet/i.test(model)) return 'sonnet';
  if (/opus/i.test(model)) return 'opus';
  if (/haiku/i.test(model)) return 'haiku';
  return 'other';
}

// A request targets the Fable model family when its `model` id names Fable
// (e.g. "claude-fable-5").
export function isFableModel(model) {
  return modelFamily(model) === 'fable';
}

// Streaming, byte-exact locator for a TOP-LEVEL string field of a JSON object,
// fed incrementally. It tracks JSON structure (container stack, key/value,
// string/escape) so it ONLY matches the field at depth 1 of the root object —
// a `"model": "..."` sitting inside conversation text (a message, a tool result)
// is nested deeper and is never mistaken for the real field. No regex, no
// whole-body buffering, so the caller can peek just the first frames.
export class TopLevelFieldFinder {
  constructor(field) {
    this.field = field;               // target key at the root, e.g. 'model'
    this.isObj = [];                  // container stack: true=object, false=array
    this.awaitingKey = false;         // at an object, the next string is a key
    this.inStr = false;
    this.esc = false;
    this.readingKey = false;
    this.readingValue = false;        // accumulating the target field's value
    this.curKey = null;               // last key seen in the current object
    this.buf = [];                    // key/value byte accumulation
    this.value = null;                // the found value, or null
    this.done = false;                // found it, or the root object closed without it
  }

  /** Feed a chunk (Buffer). Returns the found value so far (string) or null. */
  push(chunk) {
    if (this.done) return this.value;
    for (let i = 0; i < chunk.length && !this.done; i++) this.#byte(chunk[i]);
    return this.value;
  }

  #atRoot() { return this.isObj.length === 1 && this.isObj[0] === true; }

  #byte(b) {
    if (this.inStr) {
      if (this.esc) { this.esc = false; if (this.readingKey || this.readingValue) this.buf.push(b); return; }
      if (b === 0x5c) { this.esc = true; if (this.readingKey || this.readingValue) this.buf.push(b); return; } // backslash
      if (b === 0x22) {                                            // closing quote
        this.inStr = false;
        if (this.readingKey) {
          this.curKey = Buffer.from(this.buf).toString('utf8'); this.buf = []; this.readingKey = false;
        } else if (this.readingValue) {
          this.value = Buffer.from(this.buf).toString('utf8'); this.buf = [];
          this.readingValue = false; this.done = true;             // the one top-level field we want
        }
        return;
      }
      if (this.readingKey || this.readingValue) this.buf.push(b);
      return;
    }

    switch (b) {
      case 0x7b: this.isObj.push(true); this.awaitingKey = true; this.curKey = null; break;   // {
      case 0x5b: this.isObj.push(false); this.awaitingKey = false; break;                     // [
      case 0x7d: case 0x5d:                                                                    // } ]
        this.isObj.pop(); this.curKey = null;
        if (this.isObj.length === 0) this.done = true;             // root closed → field absent
        break;
      case 0x3a: this.awaitingKey = false; break;                  // :
      case 0x2c: this.awaitingKey = this.isObj[this.isObj.length - 1] === true; break;        // ,
      case 0x22:                                                   // string begins
        if (this.awaitingKey && this.isObj[this.isObj.length - 1]) {
          this.readingKey = true; this.buf = [];
        } else if (this.#atRoot() && this.curKey === this.field) {
          this.readingValue = true; this.buf = [];
        }
        this.inStr = true; this.esc = false;
        break;
      default: break;                                              // scalars / whitespace
    }
  }
}

// Extract the requested model id from a JSON request body (Buffer or string).
// Uses the streaming top-level finder so it is exact (never matches a `model`
// key nested in conversation content) and cheap on large bodies (it stops as
// soon as the top-level field resolves). Returns null if absent.
export function parseRequestModel(body) {
  if (!body) return null;
  try {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    return new TopLevelFieldFinder('model').push(buf);
  } catch { return null; }
}

// Byte-exact locator for the SECOND model an advisor request carries: Claude
// Code's advisor tool (`anthropic-beta: advisor-tool-…`) keeps the executor in
// the top-level `model` field and nests the advisor's model inside the tools
// array — `tools: [{ type: "advisor_20260301", name: "advisor", model: "…" }]`.
// The advisor sub-inference runs on the same account and spends that model's
// quota tier, so account selection must see it (DL-2841): a premium (Fable)
// advisor nested under a non-premium executor must still skip a premium-capped
// account, or Claude Code disables the advisor for the session.
//
// Same byte-machine discipline as TopLevelFieldFinder: it walks the container
// stack and only reads `type`/`model` strings that are DIRECT fields of an
// object element of the ROOT object's `tools` array — a "model" inside a tool's
// input_schema or inside conversation text is deeper (or under another root
// key) and never matches. Elements are judged when they close, so field order
// within the tool object doesn't matter.
export class AdvisorModelFinder {
  constructor() {
    this.stack = [];                  // frames: {isObj, key, awaitingKey}
    this.inStr = false;
    this.esc = false;
    this.reading = null;              // 'key' | 'type' | 'model' while in a string
    this.buf = [];
    this.toolType = null;             // fields of the tools[] element being read
    this.toolModel = null;
    this.value = null;                // the advisor model, once found
    this.done = false;
  }

  /** Feed a chunk (Buffer). Returns the found value so far (string) or null. */
  push(chunk) {
    if (this.done) return this.value;
    for (let i = 0; i < chunk.length && !this.done; i++) this.#byte(chunk[i]);
    return this.value;
  }

  // The stack is exactly [root object (last key "tools"), array, element object].
  #inToolElement() {
    const s = this.stack;
    return s.length === 3 && s[0].isObj && s[0].key === 'tools' && !s[1].isObj && s[2].isObj;
  }

  #byte(b) {
    if (this.inStr) {
      if (this.esc) { this.esc = false; if (this.reading) this.buf.push(b); return; }
      if (b === 0x5c) { this.esc = true; if (this.reading) this.buf.push(b); return; } // backslash
      if (b === 0x22) {                                            // closing quote
        this.inStr = false;
        if (this.reading) {
          const text = Buffer.from(this.buf).toString('utf8');
          if (this.reading === 'key') this.stack[this.stack.length - 1].key = text;
          else if (this.reading === 'type') this.toolType = text;
          else this.toolModel = text;
          this.reading = null;
          this.buf = [];
        }
        return;
      }
      if (this.reading) this.buf.push(b);
      return;
    }

    switch (b) {
      case 0x7b:                                                   // {
        this.stack.push({ isObj: true, key: null, awaitingKey: true });
        if (this.#inToolElement()) { this.toolType = null; this.toolModel = null; }
        break;
      case 0x5b: this.stack.push({ isObj: false, key: null, awaitingKey: false }); break; // [
      case 0x7d:                                                   // }
        if (this.#inToolElement()
            && typeof this.toolType === 'string' && /^advisor/i.test(this.toolType)
            && this.toolModel) {
          this.value = this.toolModel;
          this.done = true;
        }
        // fall through: pop like ]
      case 0x5d:                                                   // ]
        this.stack.pop();
        if (this.stack.length === 0) this.done = true;             // root closed → absent
        break;
      case 0x3a: { const t = this.stack[this.stack.length - 1]; if (t?.isObj) t.awaitingKey = false; break; } // :
      case 0x2c: { const t = this.stack[this.stack.length - 1]; if (t?.isObj) t.awaitingKey = true; break; }  // ,
      case 0x22: {                                                 // string begins
        const t = this.stack[this.stack.length - 1];
        if (t?.isObj && t.awaitingKey) this.reading = 'key';
        else if (this.#inToolElement() && (t.key === 'type' || t.key === 'model')) this.reading = t.key;
        else this.reading = null;                                  // uninteresting string: skip bytes
        this.buf = [];
        this.inStr = true;
        this.esc = false;
        break;
      }
      default: break;                                              // scalars / whitespace
    }
  }
}

// Extract the advisor model from a JSON request body, or null when the request
// carries no advisor tool. Gated on a cheap byte search for "advisor" so the
// full structural scan only runs on bodies that could possibly contain one —
// for everything else this is a single Buffer.includes.
export function parseAdvisorModel(body) {
  if (!body) return null;
  try {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    if (!buf.includes('advisor')) return null;
    return new AdvisorModelFinder().push(buf);
  } catch { return null; }
}

// Byte-exact locator for a string field that is a DIRECT field of a named
// top-level object — same discipline as AdvisorModelFinder minus the array
// layer. The stack when reading the value is exactly [root object (last key ===
// rootKey), target object]; a matching key nested deeper (message text, another
// root key) never resolves. D1DX addition (not upstream): used to surface
// `output_config.effort` on the request record for the Deck's model·effort
// Activity tag (DL-2785 — the tag itself is built by modelEffortTag below).
export class NestedStringFieldFinder {
  constructor(rootKey, field) {
    this.rootKey = rootKey;
    this.field = field;
    this.stack = [];                  // frames: {isObj, key, awaitingKey}
    this.inStr = false;
    this.esc = false;
    this.reading = null;              // 'key' | 'value' while in a string
    this.buf = [];
    this.value = null;
    this.done = false;
  }

  /** Feed a chunk (Buffer). Returns the found value so far (string) or null. */
  push(chunk) {
    if (this.done) return this.value;
    for (let i = 0; i < chunk.length && !this.done; i++) this.#byte(chunk[i]);
    return this.value;
  }

  // The stack is exactly [root object (last key === rootKey), target object].
  #inTarget() {
    const s = this.stack;
    return s.length === 2 && s[0].isObj && s[0].key === this.rootKey && s[1].isObj;
  }

  #byte(b) {
    if (this.inStr) {
      if (this.esc) { this.esc = false; if (this.reading) this.buf.push(b); return; }
      if (b === 0x5c) { this.esc = true; if (this.reading) this.buf.push(b); return; } // backslash
      if (b === 0x22) {                                            // closing quote
        this.inStr = false;
        if (this.reading === 'key') this.stack[this.stack.length - 1].key = Buffer.from(this.buf).toString('utf8');
        else if (this.reading === 'value') { this.value = Buffer.from(this.buf).toString('utf8'); this.done = true; }
        this.reading = null;
        this.buf = [];
        return;
      }
      if (this.reading) this.buf.push(b);
      return;
    }

    switch (b) {
      case 0x7b: this.stack.push({ isObj: true, key: null, awaitingKey: true }); break;      // {
      case 0x5b: this.stack.push({ isObj: false, key: null, awaitingKey: false }); break;    // [
      case 0x7d: case 0x5d:                                                                   // } ]
        this.stack.pop();
        if (this.stack.length === 0) this.done = true;             // root closed → absent
        break;
      case 0x3a: { const t = this.stack[this.stack.length - 1]; if (t?.isObj) t.awaitingKey = false; break; } // :
      case 0x2c: { const t = this.stack[this.stack.length - 1]; if (t?.isObj) t.awaitingKey = true; break; }  // ,
      case 0x22: {                                                 // string begins
        const t = this.stack[this.stack.length - 1];
        if (t?.isObj && t.awaitingKey) this.reading = 'key';
        else if (this.#inTarget() && t.key === this.field) this.reading = 'value';
        else this.reading = null;                                  // uninteresting string: skip bytes
        this.buf = [];
        this.inStr = true;
        this.esc = false;
        break;
      }
      default: break;                                              // scalars / whitespace
    }
  }
}

// Extract `output_config.effort` from a JSON request body, or null when absent.
// Gated on a cheap byte search for "effort" so the structural scan only runs on
// bodies that could carry it. Reporting only (the model·effort Activity tag,
// DL-2785); never an admission signal.
export function parseRequestEffort(body) {
  if (!body) return null;
  try {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    if (!buf.includes('effort')) return null;
    return new NestedStringFieldFinder('output_config', 'effort').push(buf);
  } catch { return null; }
}

// The `[<model>·<effort>]` Activity tag (DL-2785 render). Display-only: the
// model id is compacted for the Deck's narrow rows — the `claude-` prefix and a
// trailing `-YYYYMMDD` date stamp drop; anything else (a `[1m]` context variant,
// a non-Anthropic id) passes through verbatim. Returns '' when neither field is
// known, so rows without parsed data render exactly as before.
export function modelEffortTag(model, effort) {
  const m = (typeof model === 'string' && model)
    ? model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
    : null;
  const e = (typeof effort === 'string' && effort) ? effort : null;
  if (m == null && e == null) return '';
  return `[${m ?? '?'}${e ? '·' + e : ''}]`;
}
