import { describe, expect, it } from "vitest";
import { Endpointer, SentenceSplitter, SseParser, TV_MAX_CHARS, TvQueue, encodeWav, parseBlocks, parseSpeakers, resample, rms, speakerHint, splitSentence, storedSpeaker, stripForSpeech, troubleFor, STARTERS, TROUBLE_TEXT, TROUBLE_TONE, awayCard } from "./assistant-logic";
import { smoothLevel } from "./assistant-orb";

function splitAll(text: string, size = 3): string[] {
  const s = new SentenceSplitter();
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...s.push(text.slice(i, i + size)));
  out.push(...s.flush());
  return out;
}

describe("sentences to speak", () => {
  it("speaks each sentence as soon as it's finished", () => {
    const s = new SentenceSplitter();
    expect(s.push("Hello there")).toEqual([]);
    expect(s.push(".")).toEqual([]); // no space yet: could be "3.5"
    expect(s.push(" How")).toEqual(["Hello there."]);
    expect(s.push(" are you? I'm")).toEqual(["How are you?"]);
    expect(s.flush()).toEqual(["I'm"]);
  });
  it("doesn't split inside numbers, abbreviations or initials", () => {
    expect(splitAll("Version 3.5 is out. Dr. Smith and J. Doe agree, e.g. on this. Done.")).toEqual([
      "Version 3.5 is out.",
      "Dr. Smith and J. Doe agree, e.g. on this.",
      "Done.",
    ]);
  });
  it("treats a new line as a boundary and list numbers as markers", () => {
    expect(splitAll("Two things:\n1. The fleet is fine\n2. The GPU is hot\n")).toEqual([
      "Two things:",
      "The fleet is fine",
      "The GPU is hot",
    ]);
  });
  it("drops code blocks, even when the fence is split across deltas", () => {
    const text = "Run this. ```bash\nrm -rf nothing. Really.\n``` Then you're done.";
    for (const size of [1, 2, 3, 7, 100]) {
      expect(splitAll(text, size), `chunk size ${size}`).toEqual(["Run this.", "Then you're done."]);
    }
  });
  it("says nothing for a block that never closes", () => {
    expect(splitAll("Here. ```python\nprint('never closed')\n")).toEqual(["Here."]);
  });
  it("cuts a sentence that runs on, at a comma first", () => {
    const long = `${"word ".repeat(30)}, ${"more ".repeat(30)}`;
    const out = splitAll(long);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]!.endsWith(",")).toBe(true);
    expect(out.every((x) => x.length <= 200)).toBe(true);
    expect(out.join(" ").replace(/\s*,\s*/g, " ").split(/\s+/).length).toBe(60);
  });
  it("forgets everything on flush", () => {
    const s = new SentenceSplitter();
    s.push("```\ncode");
    expect(s.flush()).toEqual([]);
    expect(s.push("Next one. ")).toEqual(["Next one."]);
  });
});

describe("markdown stripped for speech", () => {
  const cases: [string, string][] = [
    ["**Bold** and *italic* and __under__ and _soft_ words.", "Bold and italic and under and soft words."],
    ["# A heading", "A heading"],
    ["- a bullet", "a bullet"],
    ["3. a numbered item", "a numbered item"],
    ["> a quote", "a quote"],
    ["See [the docs](https://x.example/y) now.", "See the docs now."],
    ["Open https://x.example/y?z=1 now.", "Open now."],
    ["Run `hc send` first.", "Run hc send first."],
    ["![alt](a.png) Look.", "Look."],
    ["| a | b |\n|---|---|\n| 1 | 2 |\nAfter.", "After."],
    ["<b>Bold</b> tag.", "Bold tag."],
    ["All good 🎉 today ✅.", "All good today."],
    ["snake_case_name stays, 2*3 goes on.", "snake_case_name stays, 23 goes on."],
    ["```\nonly code\n```", ""],
    ["---", ""],
    ["🎉", ""],
    ["**", ""],
  ];
  for (const [input, want] of cases) it(JSON.stringify(input), () => expect(stripForSpeech(input)).toBe(want));
});

describe("SSE", () => {
  it("parses across any chunk boundary", () => {
    const raw = 'event: delta\ndata: {"text":"a"}\n\n: keepalive\n\nevent: tool\r\ndata: {"tool":"x"}\r\n\r\ndata: one\ndata: two\n\nevent: done\ndata: {}\n\n';
    for (const size of [1, 2, 5, 1000]) {
      const p = new SseParser();
      const got = [];
      for (let i = 0; i < raw.length; i += size) got.push(...p.push(raw.slice(i, i + size)));
      expect(got).toEqual([
        { event: "delta", data: '{"text":"a"}' },
        { event: "tool", data: '{"tool":"x"}' },
        { event: "message", data: "one\ntwo" },
        { event: "done", data: "{}" },
      ]);
    }
  });
  it("doesn't emit a half-received event", () => {
    const p = new SseParser();
    expect(p.push('event: delta\ndata: {"te')).toEqual([]);
  });
});

describe("WAV", () => {
  it("writes a correct 16 kHz mono PCM16 header", () => {
    const wav = encodeWav(new Float32Array(100), 16000);
    const v = new DataView(wav);
    const tag = (at: number) => String.fromCharCode(...new Uint8Array(wav, at, 4));
    expect(wav.byteLength).toBe(44 + 200);
    expect(tag(0)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(236);
    expect(tag(8)).toBe("WAVE");
    expect(tag(12)).toBe("fmt ");
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(28, true)).toBe(32000);
    expect(v.getUint16(32, true)).toBe(2);
    expect(v.getUint16(34, true)).toBe(16);
    expect(tag(36)).toBe("data");
    expect(v.getUint32(40, true)).toBe(200);
  });
  it("encodes samples and clamps overs", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]), 16000);
    const v = new DataView(wav);
    const at = (i: number) => v.getInt16(44 + i * 2, true);
    expect([at(0), at(1), at(2), at(3), at(4)]).toEqual([0, 32767, -32768, 32767, -32768]);
    expect(at(5)).toBe(16383);
  });
  it("resamples to the right length and keeps a tone's level", () => {
    const from = 48000;
    const tone = Float32Array.from({ length: from }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / from));
    const down = resample(tone, from, 16000);
    expect(down.length).toBe(16000);
    expect(rms(down)).toBeGreaterThan(0.68);
    expect(rms(down)).toBeLessThan(0.72);
    expect(resample(tone, 44100, 16000).length).toBe(Math.round((48000 * 16000) / 44100));
    expect(resample(tone, from, from)).toBe(tone);
  });
  it("filters out what can't survive the lower rate", () => {
    const from = 48000;
    const high = Float32Array.from({ length: from }, (_, i) => Math.sin((2 * Math.PI * 12000 * i) / from));
    expect(rms(resample(high, from, 16000))).toBeLessThan(0.45 * rms(high));
  });
});

describe("end of speech", () => {
  const FRAME = 40;
  const run = (e: Endpointer, level: number, ms: number) => {
    let r = "listening";
    for (let t = 0; t < ms; t += FRAME) { r = e.feed(level, FRAME); if (r !== "listening") return r; }
    return r;
  };
  it("waits through pauses and ends after enough silence", () => {
    const e = new Endpointer({ silenceMs: 700 });
    expect(run(e, 0.001, 300)).toBe("listening");
    expect(run(e, 0.1, 800)).toBe("listening");
    expect(e.started).toBe(true);
    expect(run(e, 0.001, 500)).toBe("listening"); // a pause between words
    expect(run(e, 0.1, 400)).toBe("listening");
    expect(run(e, 0.001, 800)).toBe("ended");
  });
  it("gives up when nobody speaks", () => {
    const e = new Endpointer({ noSpeechMs: 2000 });
    expect(run(e, 0.001, 3000)).toBe("no_speech");
  });
  it("isn't fooled by a click", () => {
    const e = new Endpointer({ noSpeechMs: 2000 });
    run(e, 0.001, 200);
    e.feed(0.3, FRAME);
    expect(e.started).toBe(false);
    expect(run(e, 0.001, 3000)).toBe("no_speech");
  });
  it("copes with a noisy room", () => {
    const e = new Endpointer({ silenceMs: 700 });
    expect(run(e, 0.02, 600)).toBe("listening");
    expect(e.started).toBe(false);
    expect(run(e, 0.2, 500)).toBe("listening");
    expect(e.started).toBe(true);
    expect(run(e, 0.02, 800)).toBe("ended");
  });
  it("stops at the maximum length", () => {
    const e = new Endpointer({ maxMs: 1000 });
    run(e, 0.001, 200);
    expect(run(e, 0.2, 2000)).toBe("max_length");
  });
  it("hears someone who was already talking at the tap", () => {
    const e = new Endpointer({ silenceMs: 700 });
    let t = 0;
    const speech = () => (t++ % 8 === 7 ? 0.004 : 0.15); // words with short gaps
    let r = "listening";
    for (let i = 0; i < 50 && r === "listening"; i++) r = e.feed(speech(), FRAME);
    expect(r).toBe("listening");
    expect(e.started).toBe(true);
    expect(run(e, 0.001, 800)).toBe("ended");
  });
  it("doesn't take a steady noise for a long sentence", () => {
    const e = new Endpointer({ noSpeechMs: 4000 });
    expect(run(e, 0.03, 5000)).toBe("no_speech");
    expect(e.started).toBe(false);
  });
  it("hears speech when the room gets louder after the tap", () => {
    const e = new Endpointer({ silenceMs: 700 });
    run(e, 0.001, 300);
    // The fan comes on, then the owner talks. It's heard as speech first; it must not hang forever.
    let r = "listening";
    for (let t = 0; t < 30000 && r === "listening"; t += FRAME) r = e.feed(0.03, FRAME);
    expect(r).toBe("ended");
  });
  it("works from exact digital silence", () => {
    const e = new Endpointer({ silenceMs: 700 });
    run(e, 0, 200);
    expect(run(e, 0.05, 400)).toBe("listening");
    expect(run(e, 0, 800)).toBe("ended");
  });
});

describe("the screen's markdown", () => {
  it("handles paragraphs, bold, code and lists as data", () => {
    expect(parseBlocks("Hi **you** and `x`.\n\n- one\n- two")).toEqual([
      { type: "p", spans: [{ text: "Hi " }, { text: "you", style: "b" }, { text: " and " }, { text: "x", style: "code" }, { text: "." }] },
      { type: "li", spans: [{ text: "one" }] },
      { type: "li", spans: [{ text: "two" }] },
    ]);
  });
  it("keeps code blocks as they are, even unfinished", () => {
    expect(parseBlocks("Run:\n```bash\na  b\n```\nDone.")).toEqual([
      { type: "p", spans: [{ text: "Run:" }] },
      { type: "code", text: "a  b" },
      { type: "p", spans: [{ text: "Done." }] },
    ]);
    expect(parseBlocks("```\nstill going")).toEqual([{ type: "code", text: "still going" }]);
  });
  it("leaves html as text, for the view's text nodes", () => {
    expect(parseBlocks("<img src=x onerror=alert(1)>")).toEqual([{ type: "p", spans: [{ text: "<img src=x onerror=alert(1)>" }] }]);
  });
});

describe("what went wrong", () => {
  it("tells the failures apart", () => {
    expect(troubleFor(503, "voice_offline")).toBe("voice");
    expect(troubleFor(503, "assistant_unreachable")).toBe("assistant");
    expect(troubleFor(502, "assistant_error")).toBe("assistant");
    expect(troubleFor(401)).toBe("unpaired");
    expect(troubleFor(403)).toBe("unpaired");
    expect(troubleFor(502, "tv_failed")).toBe("tv");
    expect(troubleFor(504, "tv_timed_out")).toBe("tv");
    expect(troubleFor(503, "tv_unavailable")).toBe("tv");
  });
});

describe("her reply on the TV", () => {
  /** A TV whose calls finish when the test says so. */
  function rig() {
    const calls: { text: string; signal: AbortSignal; done: () => void; fail: (e: unknown) => void }[] = [];
    const events: string[] = [];
    const q = new TvQueue(
      (text, signal) => new Promise<void>((done, fail) => {
        calls.push({ text, signal, done, fail });
        signal.addEventListener("abort", () => fail(new DOMException("aborted", "AbortError")));
      }),
      { started: () => events.push("started"), idle: () => events.push("idle"), failed: (s, c, unsaid) => events.push(`failed ${s} ${c}: ${unsaid.join(" | ")}`) },
    );
    return { q, calls, events };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("sends the first sentence at once, and what came while it played as one", async () => {
    const { q, calls, events } = rig();
    q.say("One.");
    expect(calls.map((c) => c.text)).toEqual(["One."]);
    q.say("Two.");
    q.say("Three.");
    expect(calls.length).toBe(1);
    calls[0]!.done();
    await tick();
    expect(calls.map((c) => c.text)).toEqual(["One.", "Two. Three."]);
    expect(q.busy).toBe(true);
    calls[1]!.done();
    await tick();
    expect(q.busy).toBe(false);
    expect(events).toEqual(["started", "idle"]);
  });

  it("keeps each call within what the gateway takes", async () => {
    const { q, calls } = rig();
    q.say("a");
    q.say("x".repeat(TV_MAX_CHARS - 10));
    q.say("y".repeat(20));
    q.say("z".repeat(TV_MAX_CHARS + 5));
    for (let i = 0; i < 5 && calls.length > i; i++) { calls[i]!.done(); await tick(); }
    expect(calls.map((c) => c.text.length)).toEqual([1, TV_MAX_CHARS - 10, 20, TV_MAX_CHARS, 5]);
    expect(calls.every((c) => c.text.length <= TV_MAX_CHARS)).toBe(true);
  });

  it("cancel aborts the call and forgets the rest", async () => {
    const { q, calls, events } = rig();
    q.say("One.");
    q.say("Two.");
    q.cancel();
    expect(calls[0]!.signal.aborted).toBe(true);
    await tick();
    expect(calls.length).toBe(1);
    expect(q.busy).toBe(false);
    expect(events).toEqual(["started"]);
    q.say("Next turn.");
    await tick();
    expect(calls.map((c) => c.text)).toEqual(["One.", "Next turn."]);
  });

  it("a failure hands back everything the TV didn't say, once, and takes nothing more this turn", async () => {
    const { q, calls, events } = rig();
    q.say("One.");
    calls[0]!.done();
    await tick();
    q.say("Two.");
    q.say("Three.");
    await tick();
    q.say("Four.");
    calls[1]!.fail({ status: 502, code: "tv_failed" });
    await tick();
    q.say("Five.");
    await tick();
    expect(calls.map((c) => c.text)).toEqual(["One.", "Two."]);
    expect(events).toEqual(["started", "idle", "started", "failed 502 tv_failed: Two. | Three. | Four."]);
    q.reset();
    q.say("New turn.");
    expect(calls.map((c) => c.text)).toEqual(["One.", "Two.", "New turn."]);
  });
});

describe("where it answers", () => {
  const phone = { id: "phone", label: "Phone", available: true, listening: null };
  it("always offers the phone first, then what the gateway lists, each by its own name", () => {
    expect(parseSpeakers({ available: true, speakers: [
      { id: "tv", label: "Living room", available: true },
      { id: "kitchen", label: "Kitchen", available: true, listening: true },
      { id: "den", label: "  Den speaker  ", available: true, listening: false },
    ] })).toEqual([
      phone, { id: "tv", label: "TV", available: true, listening: null },
      { id: "kitchen", label: "Kitchen", available: true, listening: true }, { id: "den", label: "Den speaker", available: true, listening: false },
    ]);
  });
  it("names a speaker that doesn't name itself by its id, and cuts a long name", () => {
    const [, porch, long] = parseSpeakers({ speakers: [{ id: "porch", available: true }, { id: "long", label: "x".repeat(80), available: true }] });
    expect(porch.label).toBe("porch");
    expect(long.label).toHaveLength(40);
  });
  it("reads an older gateway, and nothing it doesn't know", () => {
    expect(parseSpeakers({ available: true })).toEqual([phone, { id: "tv", label: "TV", available: true, listening: null }]);
    expect(parseSpeakers({ speakers: [{ id: "phone", available: false }, { id: "../x", available: true }, { id: "" }, { id: 3 }, { id: "den" }, { id: "den", available: true }, null] }))
      .toEqual([phone, { id: "den", label: "den", available: false, listening: null }]);
    expect(parseSpeakers("nonsense")).toEqual([phone, { id: "tv", label: "TV", available: false, listening: null }]);
  });
  it("keeps an old TV setting", () => {
    expect(storedSpeaker(null, "1")).toBe("tv");
    expect(storedSpeaker(null, "0")).toBe("phone");
    expect(storedSpeaker("den", "1")).toBe("den");
    expect(storedSpeaker("../den", null)).toBe("phone");
  });
  it("tells the owner what to do only for a speaker that isn't listening", () => {
    const den = { id: "den", label: "Den", available: true };
    expect(speakerHint({ ...den, listening: false })).toBe("Den isn't listening. Open its page there and tap once.");
    expect(speakerHint({ ...den, listening: true })).toBe("");
    expect(speakerHint({ ...den, listening: null })).toBe("");
    expect(speakerHint({ ...den, available: false, listening: false })).toBe("");
    expect(speakerHint({ id: "tv", label: "TV", available: true, listening: false })).toBe("");
    expect(speakerHint(undefined)).toBe("");
  });
  it("a speaker's refusals have their own words", () => {
    expect(troubleFor(409, "speaker_not_listening")).toBe("speaker_listen");
    expect(troubleFor(409, "speaker_blocked")).toBe("speaker_listen");
    expect(troubleFor(504, "speaker_timed_out")).toBe("speaker");
    expect(troubleFor(502, "speaker_failed")).toBe("speaker");
    expect(troubleFor(503, "tv_unavailable")).toBe("tv");
  });
});

describe("when she can't be reached", () => {
  it("says why, what still works, and that it looks again by itself", () => {
    const c = awayCard("assistant");
    expect(c.what).toBe(TROUBLE_TEXT.assistant);
    expect(c.next).toMatch(/agent runtime/);
    expect(c.next).toMatch(/anything you type waits here/);
    expect(c).toMatchObject({ tone: "warn", action: "retry" });
  });
  it("tells Lumbridge not answering apart from Hermes not answering", () => {
    const c = awayCard("offline");
    expect(c.what).toBe("Can't reach Lumbridge right now.");
    expect(c.next).not.toMatch(/Hermes/);
    expect(c.tone).toBe("warn");
  });
  it("a device that isn't paired is red and goes to Settings, with no promise to look again", () => {
    const c = awayCard("unpaired");
    expect(c).toEqual({ what: "This device isn't paired any more.", next: "Pair it again from Settings.", tone: "danger", action: "settings" });
  });
  it("every trouble has a tone, and the ones that sort themselves out are amber", () => {
    for (const t of Object.keys(TROUBLE_TEXT) as (keyof typeof TROUBLE_TEXT)[]) expect(["danger", "warn"]).toContain(TROUBLE_TONE[t]);
    expect(TROUBLE_TONE.voice).toBe("warn");
    expect(TROUBLE_TONE.mic_denied).toBe("danger");
  });
});

describe("splitSentence", () => {
  it("what happened, then what to do", () => {
    expect(splitSentence(TROUBLE_TEXT.mic_denied)).toEqual(["I can't hear you.", "Allow the microphone for Lumbridge in Settings, or type below."]);
    expect(splitSentence("Voice is offline. Sam can still read and write here.")).toEqual(["Voice is offline.", "Sam can still read and write here."]);
  });
  it("one sentence stays whole", () => {
    expect(splitSentence(TROUBLE_TEXT.assistant)).toEqual([TROUBLE_TEXT.assistant, ""]);
    expect(splitSentence("I didn't catch that.")).toEqual(["I didn't catch that.", ""]);
  });
});

describe("starters", () => {
  it("three or four, each answered by a tool she has", () => {
    expect(STARTERS.length).toBeGreaterThanOrEqual(3);
    expect(STARTERS.length).toBeLessThanOrEqual(4);
    // The tools the assistant's tool list names.
    const hers = ["needs_you", "calendar", "fleet_health", "music_dj", "inbox_triage", "alerts", "agents", "music_play"];
    for (const s of STARTERS) { expect(hers).toContain(s.tool); expect(s.text.length).toBeLessThanOrEqual(34); }
  });
});

describe("the orb's level", () => {
  it("rises fast and falls slowly, and stays within 0..1", () => {
    let up = 0;
    for (let i = 0; i < 6; i++) up = smoothLevel(up, 0.2, 1 / 60);
    let down = 0.6;
    for (let i = 0; i < 6; i++) down = smoothLevel(down, 0, 1 / 60);
    expect(up).toBeGreaterThan(0.6 - down);
    expect(smoothLevel(0, 4, 1)).toBe(1);
    expect(smoothLevel(0.5, -1, 1)).toBe(0);
  });
});
