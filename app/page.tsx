"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Priority = "high" | "medium" | "low";

type Task = {
  id: string;
  title: string;
  priority: Priority;
  list: "today" | "inbox";
  time: string | null;
  deadline: string | null;
  done: boolean;
  createdAt: number;
};

type View = "welcome" | "today" | "all" | "capture" | "confirm" | "thought";
type Mood = "idle" | "listening" | "thinking" | "happy" | "calm";

const STORAGE_KEY = "ai-planner-tasks-v1";
const SEEN_KEY = "nora_seen";

const PROCESS_PHRASES = [
  "Розділяю на окремі справи…",
  "Визначаю, що важливо сьогодні…",
  "Формую твій план…",
];

const PRIORITY_LABEL: Record<Priority, string> = {
  high: "Важливо",
  medium: "Вдень",
  low: "Гнучко",
};

const PRIORITY_ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function isoOfDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function dateIsoOf(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function formatDeadline(iso: string): string {
  const parts = iso.split("-").map(Number);
  const m = parts[1];
  const d = parts[2];
  if (!m || !d) return iso;
  return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "Доброго ранку";
  if (h >= 12 && h < 18) return "Доброго дня";
  if (h >= 18 && h < 23) return "Доброго вечора";
  return "Пізня година";
}

function spravPlural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} справу`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} справи`;
  return `${n} справ`;
}

function isBurning(t: Task): boolean {
  return Boolean(t.deadline && t.deadline <= todayIso() && !t.done);
}

function sortTasks(list: Task[]): Task[] {
  return [...list].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const ab = isBurning(a) ? 0 : 1;
    const bb = isBurning(b) ? 0 : 1;
    if (ab !== bb) return ab - bb;
    if (PRIORITY_ORDER[a.priority] !== PRIORITY_ORDER[b.priority]) {
      return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    }
    if (a.time && b.time) return a.time.localeCompare(b.time);
    if (a.time) return -1;
    if (b.time) return 1;
    return a.createdAt - b.createdAt;
  });
}

function Nora({ mood, size }: { mood: Mood; size: number }) {
  return (
    <div
      className={`nora nora--${mood} flex-none`}
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

function MicIcon({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const [view, setView] = useState<View>("today");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [phrase, setPhrase] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Task[]>([]);
  const [pendingEditIdx, setPendingEditIdx] = useState<number | null>(null);
  const [pendingEditText, setPendingEditText] = useState("");
  const [lastBatch, setLastBatch] = useState<Task[]>([]);
  const [reaction, setReaction] = useState<string | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);

  const recognitionRef = useRef<any>(null);
  const baseTextRef = useRef("");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setTasks(JSON.parse(saved));
      if (localStorage.getItem(SEEN_KEY) !== "1") setView("welcome");
    } catch {
      // ignore
    }
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    setSpeechSupported(Boolean(SR));
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch {
      // ignore
    }
  }, [tasks, mounted]);

  useEffect(() => {
    if (!parsing) return;
    setPhrase(0);
    const t = setInterval(
      () => setPhrase((p) => (p + 1) % PROCESS_PHRASES.length),
      1000
    );
    return () => clearInterval(t);
  }, [parsing]);

  const markSeen = useCallback(() => {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // ignore
    }
  }, []);

  const stopListening = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      // ignore
    }
    setListening(false);
  }, []);

  const toggleListening = useCallback(() => {
    if (listening) {
      stopListening();
      return;
    }
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = "uk-UA";
    rec.continuous = true;
    rec.interimResults = true;
    baseTextRef.current = draft ? draft.trimEnd() + " " : "";
    rec.onresult = (e: any) => {
      let finalText = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      setDraft(baseTextRef.current + finalText + interim);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
      setError(null);
    } catch {
      setListening(false);
    }
  }, [draft, listening, stopListening]);

  const parse = useCallback(async () => {
    const text = draft.trim();
    if (!text || parsing) return;
    stopListening();
    setParsing(true);
    setError(null);
    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || "Щось мені завадило подумати. Спробуймо ще раз?");
        return;
      }
      const incoming: Task[] = (data.tasks || []).map(
        (
          t: {
            title: string;
            priority: Priority;
            list: Task["list"];
            time: string | null;
            deadline: string | null;
          },
          i: number
        ) => ({
          ...t,
          // Продуктове правило: важливе завжди потребує уваги сьогодні.
          list: t.priority === "high" ? ("today" as const) : t.list,
          id: uid(),
          done: false,
          createdAt: Date.now() + i,
        })
      );
      setPending(incoming);
      setPendingEditIdx(null);
      setView("confirm");
    } catch {
      setError("Звʼязок загубився. Перевір інтернет — і спробуймо ще раз.");
    } finally {
      setParsing(false);
    }
  }, [draft, parsing, stopListening]);

  const savePendingEdit = useCallback(() => {
    setPendingEditIdx((idx) => {
      if (idx !== null) {
        const text = pendingEditText.trim();
        if (text) {
          setPending((prev) =>
            prev.map((t, i) => (i === idx ? { ...t, title: text } : t))
          );
        }
      }
      return null;
    });
  }, [pendingEditText]);

  const confirmPending = useCallback(() => {
    setTasks((prev) => [...prev, ...pending]);
    setLastBatch(pending);
    setPending([]);
    setDraft("");
    setView("thought");
  }, [pending]);

  const retryCapture = useCallback(() => {
    setPending([]);
    setDraft("");
    setError(null);
    setView("capture");
  }, []);

  const toggleDone = useCallback((id: string) => {
    setTasks((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
      const t = next.find((x) => x.id === id);
      if (t?.done) {
        const todayList = next.filter((x) => x.list === "today");
        const left = todayList.filter((x) => !x.done).length;
        setReaction(
          left === 0 && todayList.length > 0
            ? "Усе виконано. Сьогодні ти молодець."
            : "Один крок зроблено. Гарний темп."
        );
        setTimeout(() => setReaction(null), 3000);
      }
      return next;
    });
  }, []);

  const removeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    setEditing(null);
  }, []);

  const saveTask = useCallback((updated: Task) => {
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    setEditing(null);
  }, []);

  const postpone = useCallback((id: string) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, list: "inbox" as const } : t))
    );
    setEditing(null);
  }, []);

  const todayList = sortTasks(tasks.filter((t) => t.list === "today"));
  const doneCount = todayList.filter((t) => t.done).length;
  const allDone = todayList.length > 0 && doneCount === todayList.length;
  const totalCount = tasks.length;

  const mood: Mood = parsing
    ? "thinking"
    : listening
    ? "listening"
    : view === "thought"
    ? "happy"
    : allDone && view === "today"
    ? "calm"
    : "idle";

  const firstOpen = todayList.find((t) => !t.done);

  if (!mounted) return <main className="min-h-dvh" />;

  /* ─────────── WELCOME ─────────── */
  if (view === "welcome") {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-8 px-6 pb-16 text-center">
        <Nora mood="idle" size={112} />
        <div>
          <p className="serif rise mb-6 text-xs uppercase tracking-[0.35em] text-[#7B7770]">
            НОРА
          </p>
          <div className="serif space-y-2 text-[22px] leading-snug text-[#191815]">
            <p className="rise-1">Я Нора.</p>
            <p className="rise-1">Ти можеш не думати про списки.</p>
            <p className="rise-2">Просто розкажи, що сьогодні на думці.</p>
            <p className="rise-3 font-semibold">Далі — моя робота.</p>
          </div>
        </div>
        <button
          onClick={() => {
            markSeen();
            setView("capture");
          }}
          className="rise-4 w-full max-w-xs rounded-2xl bg-[#191815] px-6 py-4 text-[15px] font-medium text-[#F6F5F2] transition active:scale-[0.98]"
        >
          Розповісти
        </button>
      </main>
    );
  }

  /* ─────────── CAPTURE (+ обробка) ─────────── */
  if (view === "capture") {
    if (parsing) {
      return (
        <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-8 px-6 pb-16 text-center">
          <Nora mood="thinking" size={112} />
          <p className="serif rise text-[18px] italic text-[#7B7770]">
            {PROCESS_PHRASES[phrase]}
          </p>
        </main>
      );
    }
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-6 pb-10 pt-6">
        <button
          onClick={() => {
            stopListening();
            setView("today");
          }}
          className="self-start text-sm text-[#7B7770] transition active:text-[#191815]"
        >
          ← Мій день
        </button>

        <div className="mt-6 flex flex-col items-center gap-6 text-center">
          <Nora mood={mood} size={96} />
          <h1 className="serif text-[24px] leading-snug text-[#191815]">
            Що сьогодні займає твої думки?
          </h1>

          {speechSupported && (
            <button
              onClick={toggleListening}
              className={`flex w-full max-w-xs items-center justify-center gap-2 rounded-2xl px-6 py-4 text-[15px] font-medium transition active:scale-[0.98] ${
                listening
                  ? "bg-[#B5793A] text-white"
                  : "bg-[#191815] text-[#F6F5F2]"
              }`}
            >
              <MicIcon />
              {listening ? "Слухаю… натисни, коли закінчиш" : "Говорити"}
            </button>
          )}

          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Або запиши текстом…"
            rows={4}
            className="w-full resize-none rounded-2xl border border-[#E8E5DF] bg-white/70 p-4 text-left text-[15px] leading-relaxed text-[#191815] placeholder-[#7B7770] outline-none focus:border-[#C88A4E]"
          />

          {error && (
            <p className="w-full rounded-xl bg-[#F7E7E2] p-3 text-sm text-[#A8402F]">
              {error}
            </p>
          )}

          {draft.trim() && !listening && (
            <button
              onClick={parse}
              className="rise w-full max-w-xs rounded-2xl bg-[#191815] px-6 py-4 text-[15px] font-medium text-[#F6F5F2] transition active:scale-[0.98]"
            >
              Далі
            </button>
          )}
        </div>
      </main>
    );
  }

  /* ─────────── «Ось що я зрозуміла» ─────────── */
  if (view === "confirm") {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-6 pb-10 pt-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <Nora mood="idle" size={64} />
          <h1 className="serif mt-3 text-[24px] leading-snug text-[#191815]">
            Ось що я зрозуміла
          </h1>
          <p className="text-sm text-[#7B7770]">Перевір, чи все правильно</p>
        </div>

        <ul className="mt-6 flex flex-col gap-2">
          {pending.map((t, idx) => (
            <li
              key={t.id}
              className="rise rounded-2xl border border-[#E8E5DF] bg-white/70 p-3.5"
              style={{ animationDelay: `${idx * 70}ms` }}
            >
              {pendingEditIdx === idx ? (
                <input
                  value={pendingEditText}
                  onChange={(e) => setPendingEditText(e.target.value)}
                  onBlur={savePendingEdit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") savePendingEdit();
                    if (e.key === "Escape") setPendingEditIdx(null);
                  }}
                  autoFocus
                  className="w-full rounded-xl border border-[#C88A4E] bg-white p-2 text-[15px] text-[#191815] outline-none"
                />
              ) : (
                <button
                  onClick={() => {
                    setPendingEditIdx(idx);
                    setPendingEditText(t.title);
                  }}
                  className="flex w-full items-baseline justify-between gap-3 text-left"
                >
                  <span className="text-[15px] leading-snug text-[#191815]">
                    {t.title}
                  </span>
                  {t.time && (
                    <span className="flex-none text-sm font-medium text-[#191815]">
                      {t.time}
                    </span>
                  )}
                </button>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-center text-xs text-[#7B7770]">
          Натисни на справу, щоб виправити текст
        </p>

        <div className="mt-6 flex flex-col gap-2">
          <button
            onClick={confirmPending}
            className="w-full rounded-2xl bg-[#191815] px-6 py-4 text-[15px] font-medium text-[#F6F5F2] transition active:scale-[0.98]"
          >
            Все правильно
          </button>
          <button
            onClick={retryCapture}
            className="w-full rounded-2xl border border-[#E8E5DF] px-6 py-3.5 text-[15px] text-[#7B7770] transition active:scale-[0.98]"
          >
            Записати ще раз
          </button>
        </div>
      </main>
    );
  }

  /* ─────────── РЕЗУЛЬТАТ ─────────── */
  if (view === "thought") {
    const n = lastBatch.length;
    const attention = lastBatch.filter((t) => t.list === "today").length;
    const kept = n - attention;
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-8 px-6 pb-16 text-center">
        <Nora mood="happy" size={96} />
        <div className="serif space-y-3 text-[20px] leading-snug text-[#191815]">
          <p className="rise-1">Готово.</p>
          <p className="rise-1">Я знайшла {spravPlural(n)}.</p>
          <p className="rise-2">
            {attention === 0
              ? "Сьогодні жодна не термінова — все під контролем."
              : attention === 1
              ? "Одна з них потребує уваги сьогодні."
              : `${attention} з них потребують уваги сьогодні.`}
          </p>
          {kept > 0 && (
            <p className="rise-3 text-[#7B7770]">
              Решту збережу у списку — вони не загубляться.
            </p>
          )}
        </div>
        <button
          onClick={() => setView("today")}
          className="rise-4 w-full max-w-xs rounded-2xl bg-[#191815] px-6 py-4 text-[15px] font-medium text-[#F6F5F2] transition active:scale-[0.98]"
        >
          Показати мій день
        </button>
      </main>
    );
  }

  /* ─────────── ГОЛОВНИЙ ЕКРАН: вкладки «Мій день» / «Усі справи» ─────────── */
  const isToday = view === "today";

  const tIso = todayIso();
  const yIso = isoOfDaysAgo(1);
  const groups: { label: string; items: Task[] }[] = [
    { label: "Сьогодні", items: [] },
    { label: "Вчора", items: [] },
    { label: "Раніше", items: [] },
  ];
  for (const t of sortTasks(tasks)) {
    const iso = dateIsoOf(t.createdAt);
    if (iso === tIso) groups[0].items.push(t);
    else if (iso === yIso) groups[1].items.push(t);
    else groups[2].items.push(t);
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-6 pb-32 pt-8">
      {/* Хедер: усе по центру */}
      <header className="flex flex-col items-center gap-2 text-center">
        <Nora mood={mood} size={56} />
        <p className="text-sm text-[#7B7770]">{greeting()}.</p>
      </header>

      {/* Вкладки */}
      <nav className="relative grid grid-cols-2 rounded-2xl border border-[#E8E5DF] bg-white/60 p-1">
        <div
          className={`absolute bottom-1 top-1 w-[calc(50%-4px)] rounded-xl bg-[#191815] transition-transform duration-300 ease-out ${
            isToday ? "translate-x-1" : "translate-x-[calc(100%+3px)]"
          }`}
          aria-hidden
        />
        <button
          onClick={() => setView("today")}
          className={`relative z-10 py-3 text-sm font-medium transition-colors duration-300 ${
            isToday ? "text-[#F6F5F2]" : "text-[#7B7770]"
          }`}
        >
          Мій день{todayList.length > 0 ? ` · ${todayList.length}` : ""}
        </button>
        <button
          onClick={() => setView("all")}
          className={`relative z-10 py-3 text-sm font-medium transition-colors duration-300 ${
            !isToday ? "text-[#F6F5F2]" : "text-[#7B7770]"
          }`}
        >
          Усі справи{totalCount > 0 ? ` · ${totalCount}` : ""}
        </button>
      </nav>

      {/* Контент вкладки */}
      <div key={view} className="tab-in flex flex-col gap-4">
        {isToday ? (
          <>
            {(reaction || allDone) && (
              <p className="rise rounded-2xl bg-[#6E9C86]/10 p-3 text-center text-sm text-[#6E9C86]">
                {reaction || "Усе виконано. Сьогодні ти молодець."}
              </p>
            )}

            {firstOpen && !allDone && !reaction && (
              <p className="text-center text-sm text-[#7B7770]">
                Почни з:{" "}
                <span className="font-medium text-[#191815]">
                  {firstOpen.title}
                </span>
              </p>
            )}

            {todayList.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[#E8E5DF] p-8 text-center">
                <p className="serif text-[17px] text-[#191815]">Поки тихо.</p>
                <p className="mt-1 text-sm text-[#7B7770]">
                  Розкажи, що на думці.
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {todayList.map((t, i) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    index={i}
                    onToggle={toggleDone}
                    onEdit={() => setEditing(t)}
                  />
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            {tasks.length === 0 && (
              <div className="rounded-2xl border border-dashed border-[#E8E5DF] p-8 text-center">
                <p className="serif text-[17px] text-[#191815]">Поки тихо.</p>
                <p className="mt-1 text-sm text-[#7B7770]">
                  Розкажи, що на думці.
                </p>
              </div>
            )}
            {groups.map(
              (g) =>
                g.items.length > 0 && (
                  <section key={g.label}>
                    <h2 className="mb-2 text-center text-xs font-medium uppercase tracking-wider text-[#7B7770]">
                      {g.label}
                    </h2>
                    <ul className="flex flex-col gap-2">
                      {g.items.map((t, i) => (
                        <TaskRow
                          key={t.id}
                          task={t}
                          index={i}
                          onToggle={toggleDone}
                          onEdit={() => setEditing(t)}
                        />
                      ))}
                    </ul>
                  </section>
                )
            )}
          </>
        )}
      </div>

      <MicFab
        onClick={() => {
          setDraft("");
          setView("capture");
        }}
      />

      {editing && (
        <EditSheet
          task={editing}
          onClose={() => setEditing(null)}
          onSave={saveTask}
          onPostpone={postpone}
          onDelete={removeTask}
        />
      )}
    </main>
  );
}

/* ─────────── Компоненти ─────────── */

function MicFab({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Розповісти Норі"
      className="fixed bottom-6 left-1/2 z-40 flex h-16 w-16 -translate-x-1/2 items-center justify-center rounded-full bg-[#191815] text-[#F6F5F2] shadow-lg shadow-black/25 transition active:scale-95"
    >
      <MicIcon size={26} />
    </button>
  );
}

function TaskRow({
  task,
  index,
  onToggle,
  onEdit,
}: {
  task: Task;
  index: number;
  onToggle: (id: string) => void;
  onEdit: () => void;
}) {
  const burning = isBurning(task);
  const important = task.priority === "high" && !burning;

  const surface = burning
    ? "border-l-4 border-[#E8E5DF] border-l-[#A8402F] bg-[#F7E7E2]"
    : important
    ? "border-[#C88A4E]/60 bg-[#F6DDB8]/35"
    : "border-[#E8E5DF] bg-white/70";

  return (
    <li
      className={`rise flex items-center gap-3 rounded-2xl border p-3.5 transition ${surface} ${
        task.done ? "opacity-45" : ""
      }`}
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <button
        onClick={() => onToggle(task.id)}
        aria-label="Виконано"
        className={`flex h-7 w-7 flex-none items-center justify-center rounded-full border-2 text-sm transition active:scale-90 ${
          task.done
            ? "checkpop border-[#6E9C86] bg-[#6E9C86]/15 text-[#6E9C86]"
            : "border-[#D8D4CC] text-transparent"
        }`}
      >
        ✓
      </button>
      <div className="min-w-0 flex-1">
        <p
          className={`truncate text-[15px] text-[#191815] ${
            task.done ? "line-through" : ""
          }`}
        >
          {task.title}
        </p>
        {(burning || important || task.time || task.deadline) && (
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-[#7B7770]">
            {burning && (
              <span className="rounded-full bg-[#A8402F]/10 px-2 py-0.5 font-medium text-[#A8402F]">
                прострочено
              </span>
            )}
            {important && (
              <span className="font-medium text-[#B5793A]">Важливо</span>
            )}
            {task.time && (
              <span className="font-semibold text-[#191815]">{task.time}</span>
            )}
            {task.deadline && <span>до {formatDeadline(task.deadline)}</span>}
          </p>
        )}
      </div>
      <button
        onClick={onEdit}
        aria-label="Редагувати"
        className="flex h-9 w-9 flex-none items-center justify-center rounded-xl text-[#7B7770] transition active:scale-90 active:text-[#191815]"
      >
        ✎
      </button>
    </li>
  );
}

function EditSheet({
  task,
  onClose,
  onSave,
  onPostpone,
  onDelete,
}: {
  task: Task;
  onClose: () => void;
  onSave: (t: Task) => void;
  onPostpone: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [time, setTime] = useState(task.time || "");
  const [deadline, setDeadline] = useState(task.deadline || "");
  const [priority, setPriority] = useState<Priority>(task.priority);

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/30" onClick={onClose}>
      <div
        className="sheet w-full rounded-t-3xl bg-[#F6F5F2] p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-[#E8E5DF]" />
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-2xl border border-[#E8E5DF] bg-white/70 p-3.5 text-[15px] text-[#191815] outline-none focus:border-[#C88A4E]"
        />
        <div className="mt-3 flex gap-3">
          <label className="flex-1 text-xs text-[#7B7770]">
            Час
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="mt-1 w-full rounded-2xl border border-[#E8E5DF] bg-white/70 p-3 text-[15px] text-[#191815] outline-none focus:border-[#C88A4E]"
            />
          </label>
          <label className="flex-1 text-xs text-[#7B7770]">
            Дедлайн
            <input
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className="mt-1 w-full rounded-2xl border border-[#E8E5DF] bg-white/70 p-3 text-[15px] text-[#191815] outline-none focus:border-[#C88A4E]"
            />
          </label>
        </div>
        <div className="mt-3">
          <p className="mb-1 text-xs text-[#7B7770]">Пріоритет</p>
          <div className="flex overflow-hidden rounded-2xl border border-[#E8E5DF]">
            {(["high", "medium", "low"] as Priority[]).map((p) => (
              <button
                key={p}
                onClick={() => setPriority(p)}
                className={`flex-1 py-3 text-sm transition ${
                  priority === p
                    ? "bg-[#191815] text-[#F6F5F2]"
                    : "bg-white/70 text-[#7B7770]"
                }`}
              >
                {PRIORITY_LABEL[p]}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={() =>
            onSave({
              ...task,
              title: title.trim() || task.title,
              time: time || null,
              deadline: deadline || null,
              priority,
              // Зміна пріоритету на «Важливо» переносить справу в «Мій день»
              list: priority === "high" ? "today" : task.list,
            })
          }
          className="mt-4 w-full rounded-2xl bg-[#191815] py-4 text-[15px] font-medium text-[#F6F5F2] transition active:scale-[0.98]"
        >
          Зберегти
        </button>
        <div className="mt-2 flex gap-2">
          {task.list === "today" && (
            <button
              onClick={() => onPostpone(task.id)}
              className="flex-1 rounded-2xl border border-[#E8E5DF] py-3.5 text-sm text-[#7B7770] transition active:scale-[0.98]"
            >
              Відкласти на потім
            </button>
          )}
          <button
            onClick={() => onDelete(task.id)}
            className="flex-1 rounded-2xl border border-[#E8E5DF] py-3.5 text-sm text-[#A8402F] transition active:scale-[0.98]"
          >
            Видалити
          </button>
        </div>
      </div>
    </div>
  );
}
