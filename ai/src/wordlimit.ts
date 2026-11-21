/**
 * Deterministic public-argument word limit. Words are whitespace-separated tokens (the same rule the benchmark's word
 * count uses). The model is prompted for ~30-38 words with its conclusion first; this module guarantees at most `limit`
 * (default 45) without any extra model request. Shortening order, from least to most lossy:
 *   0. trim / clause-trim:  when the text is only 1-8 words over, delete padding (filler phrases such as "in other words",
 *                           sentence openers such as "Moreover,", emphasis words such as "really"; never hedges, negations,
 *                           "just"/"simply", or an intensifier next to a negation) and, failing that, ONE short trailing clause
 *                           (at most excess + 4 words) whose tail carries no negation, hedge, qualifier or conclusion marker.
 *                           Deletion only: nothing is substituted, reordered or invented, and whole sentences are kept.
 *                           All-or-nothing: if that cannot reach the limit nothing is applied and the methods below run on the original;
 *   1. sentences:           keep WHOLE sentences chosen by priority, in their original order. Priority: the sentence that
 *                           states the conclusion (so / therefore / "fits ... better" / "Inferred:" ...) > a rebuttal of the
 *                           opponent > the first sentence > other sentences > "Observed:"-style background. A conclusion
 *                           stated last is therefore kept, and background is dropped first.
 *                           ("sentences" = the kept ones are the leading ones; "priority-sentences" = something in the middle was dropped);
 *   2. clause:              cut inside an over-long single sentence at a safe clause boundary (, ; : dash);
 *   3. word-boundary:       last resort, always flagged lossy, ends with "…" so the cut is visible.
 * A cut is "safe" when the kept part does not end on a dangling word (and, the, of, not, ...) and the dropped part does
 * not begin with a negation or qualifier (not, but, unless, however, ...), so a qualification is never silently lost.
 * This is a heuristic: keyword markers can identify the conclusion only when the text states it in a recognisable way.
 * `lossy` is set whenever anything dropped contained a negation, qualifier or conclusion marker; `conclusion` says whether
 * the central conclusion could be identified and kept. Nothing is paraphrased or invented.
 */

export const PUBLIC_WORD_LIMIT = 45;

export type WordLimitInfo = {
  limit: number;
  originalWords: number;
  finalWords: number;
  shortened: boolean;
  /** trim = only padding words deleted | clause-trim = one safe trailing clause deleted | the others drop whole sentences or cut at a word. */
  method: "none" | "trim" | "clause-trim" | "sentences" | "priority-sentences" | "clause" | "word-boundary";
  /** Exactly what a minimal method deleted (padding words / the trailing clause), for diagnosis. */
  removed?: string[];
  /** true when the cut may have dropped a qualification, a negation or part of a sentence's meaning. */
  lossy: boolean;
  /** kept: the sentence/clause stating the conclusion survives | possibly-lost: a conclusion marker was dropped | not-identified: no recognisable conclusion marker. */
  conclusion: "kept" | "possibly-lost" | "not-identified";
  /** Whole sentences removed (sentence methods). */
  droppedSentences?: number;
  /** Only when shortened: the untouched model text, for audit logs. Not for display. */
  originalText?: string;
};

export const countWords = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

const bare = (w: string) => w.toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
const DANGLING = new Set("and or the a an of to that which who because but if with for in on by as than so is are was were be has have had do does did not no never its their his her this these those from at into than nor".split(" "));
const OPENS_QUALIFICATION = new Set("but however unless except although though yet only not never no without neither nor still whereas while if cannot".split(" "));
const NEGATING = new Set(["not", "never", "no", "neither", "nor", "cannot", "without", "n't"]);

/** Marks a sentence that states what the speaker concludes; a later one wins when several do. */
const CONCLUSION = /\b(?:therefore|thus|hence|which means|that means|this means|it follows|fits (?:[a-z-]+ ){0,6}?(?:better|best)|points? (?:to|toward|towards)|(?:best|simplest|likelier|likely) explanation|in short|overall|that is why|inferred:|conclusion:)|,\s*so\b/i;
/** A negation, hedge or qualification: dropping a sentence that holds one is flagged as potentially lossy. */
const NEG_OR_QUALIFIER = /\b(?:not|no|never|nor|without|cannot|unless|except|might|may|could|possibly|perhaps|probably|unproven|unclear|uncertain|unknown)\b|n['’]t\b/i;
const BACKGROUND = /^(?:observed|observation|observations|evidence|fact|facts|background|noted?)\s*:/i;
const REBUTTAL = /\bAgent [AB]\b|\byour opponent\b|\bopponent\b|\b[AB] (?:says|claims|argues|insists|suggests|assumes)\b|\bbut\b|\bhowever\b/i;
const QUALIFIER_START = ["but", "however", "unless", "except", "although", "though", "yet", "still", "whereas"];

function result(text: string, original: string, originalWords: number, limit: number, method: WordLimitInfo["method"], lossy: boolean, conclusion: WordLimitInfo["conclusion"] = "not-identified", droppedSentences?: number, removed?: string[]): { text: string; info: WordLimitInfo } {
  return {
    text,
    info: { limit, originalWords, finalWords: countWords(text), shortened: method !== "none", method, lossy, conclusion: method === "none" ? "kept" : conclusion, ...(droppedSentences !== undefined ? { droppedSentences } : {}), ...(removed ? { removed } : {}), ...(method !== "none" ? { originalText: original } : {}) },
  };
}

/** Importance of a whole sentence when space is short (higher = keep). Deterministic. */
function priority(s: string, i: number): number {
  if (CONCLUSION.test(s)) return 100 + i;
  if (BACKGROUND.test(s)) return NEG_OR_QUALIFIER.test(s) ? 15 : 5;
  if (QUALIFIER_START.includes(bare(s.split(" ")[0]))) return 25; // "However, ..." modifies the sentence before it: never outranks it (dropping it is flagged lossy)
  if (REBUTTAL.test(s)) return 70;
  return i === 0 ? 60 : 20;
}

const stripTail = (s: string) => s.replace(/[\s,;:—–-]+$/u, "");

/** Never start on orphaned punctuation, never end on a dangling separator. Whole words only: nothing is invented. */
const tidy = (s: string) => stripTail(s.replace(/^[\s,;:.—–)\]-]+/u, "")).trim();

/** Quotes and brackets opened inside the kept text are closed inside it (a cut must not leave a dangling quotation). */
function balanced(s: string): boolean {
  const count = (re: RegExp) => (s.match(re) ?? []).length;
  return count(/"/g) % 2 === 0 && count(/\(/g) === count(/\)/g);
}

const ABBREVIATION = /^(mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|no|inc|ltd|co|approx|fig|e\.g|i\.e|a\.m|p\.m|u\.s|u\.k)$/i;

/**
 * Splits into sentences as CONTIGUOUS slices of the text (nothing between two slices is ever skipped). A full stop is not a
 * sentence end inside "a.m.", an initial ("J. Smith"), a title or abbreviation, a number ("1.5"), or when the next word is
 * lower case. An abbreviation at a real sentence end therefore merges two sentences, which only makes a later cut safer.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!/[.!?…]/.test(text[i])) continue;
    let j = i;
    while (j + 1 < text.length && /[.!?…]/.test(text[j + 1])) j++;
    let k = j;
    while (k + 1 < text.length && /["')\]”’]/.test(text[k + 1])) k++;
    const atEnd = k + 1 >= text.length;
    if (!atEnd && !/\s/.test(text[k + 1])) {
      i = k; // "a.m.,", "1.5", "etc.)": the stop is inside a token
      continue;
    }
    if (!atEnd && text[i] === "." && j === i) {
      const before = /([A-Za-z.]+)$/.exec(text.slice(start, i))?.[1] ?? "";
      const next = text.slice(k + 1).trimStart()[0] ?? "";
      if (ABBREVIATION.test(before) || /^[A-Za-z]$/.test(before) || /[a-z]/.test(next)) {
        i = k;
        continue;
      }
    }
    out.push(text.slice(start, k + 1).trim());
    start = k + 1;
    i = k;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

// ---- Minimal shortening for a small excess (1-8 words): remove padding, not meaning ----

/** Beyond this excess a whole-sentence choice is more honest than many small cuts. */
const MINIMAL_EXCESS = 8;
const NEG_WORDS = new Set(["not", "never", "no", "nor", "hardly", "barely", "without", "cannot"]);
const isNeg = (t: string | undefined) => !!t && (NEG_WORDS.has(bare(t)) || /n['’]t$/i.test(bare(t)));
/** Multi-word padding. Each removal is a deletion only (nothing is substituted or reordered). */
const FILLER_PHRASES = ["in other words", "as a matter of fact", "it is worth noting that", "it should be noted that", "it is important to note that", "needless to say", "to be clear", "for what it's worth", "at the end of the day", "in fact", "in order", "as well", "at all"].map((p) => p.split(" "));
/** Discourse openers: only removed at the start of a sentence, together with their comma. */
const OPENERS = new Set(["moreover", "furthermore", "additionally", "indeed", "frankly", "honestly", "basically", "essentially", "well"]);
/** Emphasis words (never hedges such as might / perhaps / probably, never "just" or "simply", which can mean "only"). */
const INTENSIFIERS = new Set(["very", "really", "quite", "clearly", "obviously", "plainly", "actually", "literally", "certainly", "definitely", "absolutely", "truly", "also"]);

const plainToken = (t: string, i = 0) => i > 0 ? !/[,;:.!?…]$/.test(t) : true;
const hasQuoteOrBracket = (ts: string[]) => ts.some((t) => /["'()\[\]“”]/.test(t.replace(/\w['’]\w/g, "")));

/** Finds the first safe deletion in `tokens`: { at, n } or undefined. Tier order: filler phrases, sentence openers, emphasis words. */
function findDeletion(tokens: string[]): { at: number; n: number } | undefined {
  const startsSentence = (i: number) => i === 0 || /[.!?…]["')\]]*$/.test(tokens[i - 1]);
  for (const words of FILLER_PHRASES) {
    for (let i = 0; i + words.length <= tokens.length; i++) {
      const span = tokens.slice(i, i + words.length);
      if (!span.every((t, k) => bare(t) === words[k] && plainToken(t, k < words.length - 1 ? 1 : 0))) continue;
      const next = bare(tokens[i + words.length] ?? "");
      const prev = bare(tokens[i - 1] ?? "");
      if (words.join(" ") === "in order" && next !== "to") continue; // "in order to" -> "to"
      if (words.join(" ") === "as well" && next === "as") continue; // keep "as well as"
      if (words.join(" ") === "at all" && (prev === "if" || prev === "not")) continue; // "if at all", "not at all" are not padding
      if (hasQuoteOrBracket(span) || (/[.!?…]$/.test(span[span.length - 1]) && i + words.length < tokens.length)) continue;
      return { at: i, n: words.length };
    }
  }
  for (let i = 0; i < tokens.length - 1; i++) if (startsSentence(i) && OPENERS.has(bare(tokens[i])) && /,$/.test(tokens[i]) && !hasQuoteOrBracket([tokens[i]])) return { at: i, n: 1 };
  for (let i = 0; i < tokens.length; i++) {
    if (!INTENSIFIERS.has(bare(tokens[i])) || hasQuoteOrBracket([tokens[i]])) continue;
    if (isNeg(tokens[i - 1]) || isNeg(tokens[i - 2]) || isNeg(tokens[i + 1])) continue; // "not really" softens: deleting "really" would harden the claim
    if (/[,;:]$/.test(tokens[i]) || i === tokens.length - 1) continue;
    return { at: i, n: 1 };
  }
  return undefined;
}

/** Deletes tokens[at..at+n) and repairs the commas / capital letter around the gap. Returns undefined if no clean repair exists. */
function deleteSpan(tokens: string[], at: number, n: number): string[] | undefined {
  const trailing = /[,;:.!?…]+$/.exec(tokens[at + n - 1])?.[0] ?? "";
  const out = [...tokens.slice(0, at), ...tokens.slice(at + n)];
  if (at === 0 || /[.!?…]["')\]]*$/.test(tokens[at - 1])) {
    if (!out[at] || /[.!?…]$/.test(trailing)) return undefined;
    out[at] = out[at][0].toUpperCase() + out[at].slice(1); // the next word now starts the sentence
    return out;
  }
  if (/[.!?…]/.test(trailing)) out[at - 1] = out[at - 1].replace(/[,;:]+$/, "") + trailing; // phrase ended the sentence: its full stop moves back
  else if (/[;:]/.test(trailing) && !/[,;:]$/.test(out[at - 1])) out[at - 1] += trailing;
  return out;
}

/** Removes padding until the text fits. All-or-nothing: if it cannot reach the limit this way, nothing is changed. */
export function minimalTrim(text: string, limit: number): { text: string; removed: string[] } | undefined {
  let tokens = text.split(" ");
  const removed: string[] = [];
  while (tokens.length > limit) {
    const d = findDeletion(tokens);
    if (!d) return undefined;
    const next = deleteSpan(tokens, d.at, d.n);
    if (!next) return undefined;
    removed.push(tokens.slice(d.at, d.at + d.n).join(" ").replace(/[,;:]+$/, ""));
    tokens = next;
  }
  return removed.length && balanced(tokens.join(" ")) ? { text: tokens.join(" "), removed } : undefined;
}

/**
 * Next smallest safe cut: drop ONE trailing clause (after a comma / semicolon / dash) from one sentence, instead of a whole
 * sentence. The tail must be at least as long as the excess, must not start a qualification or contain a negation, hedge
 * or conclusion marker, and the kept part must not end on a dangling word. The shortest such tail wins.
 */
export function clauseTrim(text: string, limit: number): { text: string; removed: string } | undefined {
  const excess = countWords(text) - limit;
  const sentences = splitSentences(text);
  let best: { si: number; kept: string; removed: string; n: number } | undefined;
  for (const [si, s] of sentences.entries()) {
    const tokens = s.split(" ");
    const terminal = /[.!?…]$/.test(s) ? s[s.length - 1] : ".";
    for (let i = tokens.length - 1; i >= 6; i--) {
      const dash = ["—", "–", "-"].includes(tokens[i] ?? "");
      if (!(/[,;:]$/.test(tokens[i - 1]) || dash)) continue;
      const tail = tokens.slice(dash ? i + 1 : i);
      if (tail.length < excess || tail.length > excess + 4) continue; // a minimal cut: never much more than the excess
      const lastKept = bare(tokens[i - 1]);
      const droppedText = tokens.slice(i - 1).join(" ");
      if (DANGLING.has(lastKept) || OPENS_QUALIFICATION.has(bare(tail[0] ?? "")) || NEG_OR_QUALIFIER.test(droppedText) || CONCLUSION.test(droppedText)) continue;
      const kept = tidy(tokens.slice(0, i).join(" "));
      if (!balanced(kept) || countWords(kept) < 6) continue;
      if (!best || tail.length < best.n || (tail.length === best.n && si > best.si)) best = { si, kept: kept.replace(/[.!?…]+$/, "") + terminal, removed: tail.join(" "), n: tail.length };
    }
  }
  if (!best) return undefined;
  const rebuilt = sentences.map((s, i) => (i === best!.si ? best!.kept : s)).join(" ");
  return countWords(rebuilt) <= limit ? { text: rebuilt, removed: best.removed } : undefined;
}

/** Returns text with at most `limit` words, plus how it was obtained. Never throws. */
export function enforceWordLimit(raw: string, limit = PUBLIC_WORD_LIMIT): { text: string; info: WordLimitInfo } {
  const original = raw;
  const text = raw.replace(/\s+/g, " ").trim();
  const originalWords = countWords(text);
  if (originalWords <= limit) return result(text, original, originalWords, limit, "none", false);

  // 0. a small excess is fixed with the smallest safe deletion, never by dropping a whole sentence
  if (originalWords - limit <= MINIMAL_EXCESS) {
    const conclusionOf = (kept: string): WordLimitInfo["conclusion"] => (CONCLUSION.test(kept) ? "kept" : CONCLUSION.test(text) ? "possibly-lost" : "not-identified");
    const trimmed = minimalTrim(text, limit);
    if (trimmed) return result(trimmed.text, original, originalWords, limit, "trim", false, conclusionOf(trimmed.text), 0, trimmed.removed);
    const clause = clauseTrim(text, limit);
    if (clause) return result(clause.text, original, originalWords, limit, "clause-trim", false, conclusionOf(clause.text), 0, [clause.removed]);
  }

  // 1. whole sentences
  const sentences = splitSentences(text);
  const prio = sentences.map((s, i) => priority(s, i));
  const chosen = new Set<number>();
  let used = 0;
  let plainClosed = false; // ordinary sentences are taken in order and stop at the first that does not fit (a leading prefix)
  for (const i of [...sentences.keys()].sort((a, b) => prio[b] - prio[a] || a - b)) {
    if (prio[i] < 60 && plainClosed) continue;
    const n = countWords(sentences[i]);
    if (used + n <= limit) {
      chosen.add(i);
      used += n;
    } else if (prio[i] < 60) plainClosed = true;
  }
  const keptIdx = [...chosen].sort((a, b) => a - b);
  const kept = keptIdx.map((i) => sentences[i]);
  if (kept.length && balanced(kept.join(" "))) {
    const droppedIdx = sentences.map((_, i) => i).filter((i) => !chosen.has(i));
    const dropped = droppedIdx.map((i) => sentences[i]);
    const risky = dropped.some((s) => QUALIFIER_START.includes(bare(s.split(" ")[0])) || NEG_OR_QUALIFIER.test(s) || CONCLUSION.test(s));
    const conclusionIdx = sentences.map((s, i) => (CONCLUSION.test(s) ? i : -1)).filter((i) => i >= 0);
    const conclusion = !conclusionIdx.length ? "not-identified" : conclusionIdx.some((i) => chosen.has(i)) ? "kept" : "possibly-lost";
    const leading = keptIdx.every((v, k) => v === k);
    return result(tidy(kept.join(" ")), original, originalWords, limit, leading ? "sentences" : "priority-sentences", risky, conclusion, dropped.length);
  }

  // 2. clause boundary inside the first sentence
  const tokens = text.split(" ");
  const isBoundary = (i: number) => /[,;:]$/.test(tokens[i - 1]) || ["—", "–", "-"].includes(tokens[i] ?? "");
  for (let i = Math.min(limit, tokens.length - 1); i >= 8; i--) {
    if (!isBoundary(i)) continue;
    const last = bare(tokens[i - 1]);
    const next = bare(tokens[i] === "—" || tokens[i] === "–" || tokens[i] === "-" ? tokens[i + 1] ?? "" : tokens[i] ?? "");
    if (DANGLING.has(last) || OPENS_QUALIFICATION.has(next)) continue;
    if (!balanced(tokens.slice(0, i).join(" "))) continue;
    let out = tidy(tokens.slice(0, i).join(" "));
    if (!/[.!?…]$/.test(out)) out += ".";
    const dropped = tokens.slice(i).join(" ");
    const keptText = tokens.slice(0, i).join(" ");
    return result(out, original, originalWords, limit, "clause", NEG_OR_QUALIFIER.test(dropped) || CONCLUSION.test(dropped), CONCLUSION.test(keptText) ? "kept" : CONCLUSION.test(dropped) ? "possibly-lost" : "not-identified");
  }

  // 3. word boundary, backing off from dangling words and from cutting right before a negation or qualifier
  let i = limit;
  const floor = Math.max(8, limit - 12);
  while (i > floor && (DANGLING.has(bare(tokens[i - 1])) || NEGATING.has(bare(tokens[i] ?? "")) || OPENS_QUALIFICATION.has(bare(tokens[i] ?? "")) || !balanced(tokens.slice(0, i).join(" ")))) i--;
  let out = tidy(tokens.slice(0, i).join(" "));
  if (!/[.!?…]$/.test(out)) out += "…";
  const droppedTail = tokens.slice(i).join(" ");
  return result(out, original, originalWords, limit, "word-boundary", true, CONCLUSION.test(tokens.slice(0, i).join(" ")) ? "kept" : CONCLUSION.test(droppedTail) ? "possibly-lost" : "not-identified");
}
